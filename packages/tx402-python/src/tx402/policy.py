"""Local policy evaluation in the exact SPEC §6.3 order."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType
from typing import Any, Final
from urllib.parse import urlsplit

from tx402.errors import (
    BudgetExceededError,
    ClockSkewError,
    ConfigurationError,
    DomainNotAllowedError,
    InvalidPaymentRequiredError,
    Tx402ErrorContext,
    UnsupportedSchemeError,
)
from tx402.ledger import MemorySpendStore
from tx402.manifest import require_network
from tx402.money import MoneyAssetMetadata, MoneyParseError, parse_positive_money_atomic

DEFAULT_MAX_PER_REQUEST: Final = "0.50 USDC"
DEFAULT_MAX_PER_HOUR: Final = "10.00 USDC"
DEFAULT_MAX_QUOTE_AGE_MS: Final = 5_000
MAX_FUTURE_SKEW_MS: Final = 15_000


@dataclass(frozen=True, slots=True)
class Policy:
    max_per_request: object = DEFAULT_MAX_PER_REQUEST
    max_per_hour: object = DEFAULT_MAX_PER_HOUR
    allowed_networks: Sequence[str] | None = None
    allowed_domains: Sequence[str] = ("*",)
    max_paid_attempts: int = 2

    def __post_init__(self) -> None:
        if self.allowed_networks is not None:
            object.__setattr__(self, "allowed_networks", tuple(self.allowed_networks))
        object.__setattr__(self, "allowed_domains", tuple(self.allowed_domains))


@dataclass(frozen=True, slots=True)
class RoutingPolicy:
    max_quote_age_ms: int = DEFAULT_MAX_QUOTE_AGE_MS
    prefer_networks: Sequence[str] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "prefer_networks", tuple(self.prefer_networks))


@dataclass(frozen=True, slots=True)
class PolicyRequirement:
    requirement: Mapping[str, Any]
    asset_id: str
    manifest_asset: Mapping[str, Any]
    max_per_request_atomic: str
    max_per_hour_atomic: str


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    normalized_host: str
    requirements: tuple[PolicyRequirement, ...]


@dataclass(frozen=True, slots=True)
class _PreparedAsset:
    manifest: Mapping[str, Any]
    asset_id: str
    max_per_request: int
    max_per_hour: int


def _configuration(
    path: str, reason: str, cause: BaseException | None = None
) -> ConfigurationError:
    return ConfigurationError(
        f"Invalid {path}: {reason}",
        context=Tx402ErrorContext(request_id="configuration", phase="initial"),
        details={"configPath": path, "reason": reason},
        cause=cause,
    )


def normalize_policy_host(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.hostname is None:
        raise ValueError("Policy URL must be absolute")
    return parsed.hostname.lower().rstrip(".")


def _normalize_domain_pattern(value: str, index: int) -> str:
    if value == "*":
        return value
    wildcard = value.startswith("*.")
    candidate = value[2:] if wildcard else value
    if not candidate or any(character in candidate for character in ":/@"):
        raise _configuration(f"policy.allowed_domains[{index}]", "invalid-domain-pattern")
    try:
        host = normalize_policy_host(f"https://{candidate}")
    except ValueError as error:
        raise _configuration(
            f"policy.allowed_domains[{index}]", "invalid-domain-pattern", error
        ) from error
    return f"*.{host}" if wildcard else host


def _domain_matches(host: str, pattern: str) -> bool:
    if pattern == "*":
        return True
    if not pattern.startswith("*."):
        return host == pattern
    suffix = pattern[1:]
    return host.endswith(suffix) and len(host) > len(suffix)


def _asset_reference(asset: Mapping[str, Any]) -> str:
    reference = asset.get("address", asset.get("mint"))
    if not isinstance(reference, str):
        raise ValueError("Manifest asset has no address or mint")
    return reference


def _asset_matches(
    network: Mapping[str, Any], asset: Mapping[str, Any], offered: str
) -> bool:
    expected = _asset_reference(asset)
    return (
        expected.lower() == offered.lower() if "chainId" in network else expected == offered
    )


def _asset_id(network_id: str, network: Mapping[str, Any], asset: Mapping[str, Any]) -> str:
    namespace = "erc20" if "chainId" in network else "token"
    return f"{network_id}/{namespace}:{_asset_reference(asset)}"


def _timestamp_from_extra(extra: Mapping[str, Any]) -> int | None:
    if "timestamp" not in extra:
        return None
    value = extra["timestamp"]
    if isinstance(value, str) and value.endswith("Z"):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            epoch = datetime.fromisoformat("1970-01-01T00:00:00+00:00")
            delta = parsed - epoch
            return (
                delta.days * 86_400_000
                + delta.seconds * 1_000
                + delta.microseconds // 1_000
            )
        except ValueError:
            pass
    raise TypeError("quote-timestamp-invalid")


class PolicyEngine:
    """Immutable policy evaluator. It performs no network or signer calls."""

    def __init__(
        self,
        manifest: Mapping[str, Any],
        policy: Policy | None = None,
        routing: RoutingPolicy | None = None,
    ) -> None:
        configured = policy or Policy()
        route_policy = routing or RoutingPolicy()
        networks: Mapping[str, Mapping[str, Any]] = manifest["networks"]
        selected = configured.allowed_networks
        if selected is None:
            selected = tuple(
                network_id
                for network_id, network in networks.items()
                if network.get("environment") == "production"
            )
        if not selected:
            raise _configuration("policy.allowed_networks", "empty-list")
        resolved: list[str] = []
        for index, configured_network in enumerate(selected):
            if not isinstance(configured_network, str):
                raise _configuration(f"policy.allowed_networks[{index}]", "expected-string")
            resolved.append(
                require_network(
                    manifest,
                    configured_network,
                    Tx402ErrorContext(request_id="configuration", phase="initial"),
                    f"policy.allowed_networks[{index}]",
                )
            )
        self._manifest = manifest
        self._allowed_networks = frozenset(resolved)

        if not configured.allowed_domains:
            raise _configuration("policy.allowed_domains", "empty-list")
        self._allowed_domains = tuple(
            _normalize_domain_pattern(pattern, index)
            if isinstance(pattern, str)
            else (_raise_expected_domain(index))
            for index, pattern in enumerate(configured.allowed_domains)
        )
        if (
            isinstance(configured.max_paid_attempts, bool)
            or not isinstance(configured.max_paid_attempts, int)
            or not 1 <= configured.max_paid_attempts <= 3
        ):
            raise _configuration("policy.max_paid_attempts", "integer-out-of-range")
        self.max_paid_attempts = configured.max_paid_attempts
        if (
            isinstance(route_policy.max_quote_age_ms, bool)
            or not isinstance(route_policy.max_quote_age_ms, int)
            or route_policy.max_quote_age_ms < 0
        ):
            raise _configuration(
                "routing.max_quote_age_ms", "expected-non-negative-integer"
            )
        self._max_quote_age_ms = route_policy.max_quote_age_ms
        preferences: list[str] = []
        for index, preferred_network in enumerate(route_policy.prefer_networks):
            if not isinstance(preferred_network, str):
                raise _configuration(f"routing.prefer_networks[{index}]", "expected-string")
            preferences.append(
                require_network(
                    manifest,
                    preferred_network,
                    Tx402ErrorContext(request_id="configuration", phase="initial"),
                    f"routing.prefer_networks[{index}]",
                )
            )
        self.prefer_networks = tuple(preferences)

        assets: dict[str, _PreparedAsset] = {}
        for network_id in self._allowed_networks:
            manifest_network = networks[network_id]
            manifest_assets: Sequence[Mapping[str, Any]] = manifest_network["assets"]
            for asset in manifest_assets:
                metadata = MoneyAssetMetadata(asset["symbol"], asset["decimals"])
                try:
                    per_request = parse_positive_money_atomic(
                        configured.max_per_request, metadata
                    )
                except MoneyParseError as error:
                    raise _configuration(
                        "policy.max_per_request", error.reason, error
                    ) from error
                try:
                    per_hour = parse_positive_money_atomic(
                        configured.max_per_hour, metadata
                    )
                except MoneyParseError as error:
                    raise _configuration(
                        "policy.max_per_hour", error.reason, error
                    ) from error
                if per_hour < per_request:
                    raise _configuration("policy.max_per_hour", "below-max-per-request")
                reference = _asset_reference(asset)
                assets[f"{network_id}\0{reference}"] = _PreparedAsset(
                    MappingProxyType(dict(asset)),
                    _asset_id(network_id, manifest_network, asset),
                    per_request,
                    per_hour,
                )
        self._assets = MappingProxyType(assets)

    def assert_domain(self, url: str, request_id: str, phase: str = "initial") -> str:
        host = normalize_policy_host(url)
        if not any(_domain_matches(host, pattern) for pattern in self._allowed_domains):
            raise DomainNotAllowedError(
                "Destination domain is not allowed",
                context=Tx402ErrorContext(request_id=request_id, phase=phase),  # type: ignore[arg-type]
                details={"normalizedHost": host},
            )
        return host

    def evaluate(
        self,
        payment_required: Mapping[str, Any],
        *,
        request_id: str,
        policy_scope: str,
        now_epoch_ms: int,
        spend_store: MemorySpendStore,
    ) -> PolicyDecision:
        context = Tx402ErrorContext(request_id=request_id, phase="policy")
        host = self.assert_domain(payment_required["resource"]["url"], request_id, "policy")
        requirements: list[Mapping[str, Any]] = payment_required["requirements"]

        allowed = [
            requirement
            for requirement in requirements
            if requirement["network"] in self._allowed_networks
            and requirement["network"] in self._manifest["networks"]
        ]
        if not allowed:
            raise UnsupportedSchemeError(
                "No allowed payment network was offered",
                context=context,
                details=_offered(requirements),
            )

        supported: list[tuple[Mapping[str, Any], _PreparedAsset]] = []
        for requirement in allowed:
            network = self._manifest["networks"][requirement["network"]]
            if requirement["scheme"] != "exact":
                continue
            match = next(
                (
                    asset
                    for asset in network["assets"]
                    if requirement["scheme"] in asset["schemes"]
                    and _asset_matches(network, asset, requirement["asset"])
                ),
                None,
            )
            if match is not None:
                prepared = self._assets.get(
                    f"{requirement['network']}\0{_asset_reference(match)}"
                )
                if prepared is not None:
                    supported.append((requirement, prepared))
        if not supported:
            raise UnsupportedSchemeError(
                "No supported payment scheme and asset was offered",
                context=context,
                details=_offered(allowed),
            )

        under_cap = [
            pair
            for pair in supported
            if int(pair[0]["amountAtomic"]) <= pair[1].max_per_request
        ]
        if not under_cap:
            requirement, asset = min(
                supported, key=lambda pair: int(pair[0]["amountAtomic"])
            )
            raise BudgetExceededError(
                "Payment exceeds the per-request limit",
                context=Tx402ErrorContext(
                    request_id=request_id,
                    phase="policy",
                    network=requirement["network"],
                    scheme=requirement["scheme"],
                    amount_atomic=requirement["amountAtomic"],
                    asset_id=asset.asset_id,
                ),
                details={
                    "requestedAtomic": requirement["amountAtomic"],
                    "capAtomic": str(asset.max_per_request),
                    "committedAtomic": "0",
                    "reservedAtomic": "0",
                    "capKind": "per-request",
                },
            )

        within_hour: list[PolicyRequirement] = []
        last: tuple[Mapping[str, Any], _PreparedAsset, str, str] | None = None
        for requirement, asset in under_cap:
            state = spend_store.get_budget_state(
                policy_scope=policy_scope,
                asset_id=asset.asset_id,
                now_epoch_ms=now_epoch_ms,
            )
            last = requirement, asset, state.committed_atomic, state.reserved_atomic
            if (
                int(state.committed_atomic)
                + int(state.reserved_atomic)
                + int(requirement["amountAtomic"])
                <= asset.max_per_hour
            ):
                within_hour.append(
                    PolicyRequirement(
                        MappingProxyType(dict(requirement)),
                        asset.asset_id,
                        asset.manifest,
                        str(asset.max_per_request),
                        str(asset.max_per_hour),
                    )
                )
        if not within_hour and last is not None:
            requirement, asset, committed, reserved = last
            raise BudgetExceededError(
                "Payment would exceed the rolling hourly limit",
                context=Tx402ErrorContext(
                    request_id=request_id,
                    phase="policy",
                    network=requirement["network"],
                    scheme=requirement["scheme"],
                    amount_atomic=requirement["amountAtomic"],
                    asset_id=asset.asset_id,
                ),
                details={
                    "requestedAtomic": requirement["amountAtomic"],
                    "capAtomic": str(asset.max_per_hour),
                    "committedAtomic": committed,
                    "reservedAtomic": reserved,
                    "capKind": "per-hour",
                },
            )

        fresh: list[PolicyRequirement] = []
        for item in within_hour:
            try:
                timestamp = _timestamp_from_extra(item.requirement["extra"])
            except TypeError as error:
                raise InvalidPaymentRequiredError(
                    "Quote timestamp is invalid",
                    context=context,
                    details={
                        "reason": "quote-timestamp-invalid",
                        "schemaPath": "/accepts/*/extra/timestamp",
                    },
                    cause=error,
                ) from error
            if timestamp is None:
                fresh.append(item)
            elif timestamp - now_epoch_ms > MAX_FUTURE_SKEW_MS:
                raise ClockSkewError(
                    "Quote timestamp is unreasonably future-dated",
                    context=context,
                    details={
                        "observedSkewMs": timestamp - now_epoch_ms,
                        "thresholdMs": MAX_FUTURE_SKEW_MS,
                    },
                )
            elif now_epoch_ms - timestamp <= self._max_quote_age_ms:
                fresh.append(item)
        if not fresh:
            raise InvalidPaymentRequiredError(
                "Payment quote has expired",
                context=context,
                details={
                    "reason": "quote-expired",
                    "schemaPath": "/accepts/*/extra/timestamp",
                },
            )
        return PolicyDecision(host, tuple(fresh))


def _raise_expected_domain(index: int) -> str:
    raise _configuration(f"policy.allowed_domains[{index}]", "expected-string")


def _offered(requirements: Sequence[Mapping[str, Any]]) -> dict[str, list[str]]:
    return {
        "offeredSchemes": list(dict.fromkeys(item["scheme"] for item in requirements)),
        "offeredNetworks": list(dict.fromkeys(item["network"] for item in requirements)),
    }
