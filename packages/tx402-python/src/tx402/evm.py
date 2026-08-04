"""Base/EVM exact-scheme planning, RPC validation, and signer adaptation (SPEC §7.1)."""

from __future__ import annotations

import asyncio
import queue
import re
import threading
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Final, Literal, Protocol, TypeVar, runtime_checkable

import httpx
from x402.schemas import PaymentRequirements

from tx402.errors import (
    InvalidPaymentRequiredError,
    SignerError,
    Tx402ErrorContext,
    UnsupportedSchemeError,
)
from tx402.money import format_money_decimal

BALANCE_OF_SELECTOR: Final = "0x70a08231"
SUPPORTED_ASSET_TRANSFER_METHOD: Final = "eip3009"
MAX_AUTHORIZATION_SECONDS: Final = 60
MAX_PROVIDERS_PER_NETWORK: Final = 2
RPC_TIMEOUT_MS: Final = 600

_ADDRESS: Final = re.compile(r"^0x[0-9a-fA-F]{40}$")
_NONCE: Final = re.compile(r"^0x[0-9a-fA-F]{64}$")
_QUANTITY: Final = re.compile(r"^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$")


@dataclass(frozen=True, slots=True)
class EvmSignerPresentation:
    network: str
    asset_id: str
    asset_symbol: str
    amount_atomic: str
    amount_decimal: str
    recipient: str
    resource_host: str
    domain_name: str
    expires_at: str
    request_hash: str


@dataclass(frozen=True, slots=True)
class EvmTypedDataRequest:
    domain: Mapping[str, Any]
    types: Mapping[str, tuple[Mapping[str, str], ...]]
    primary_type: str
    message: Mapping[str, Any]
    presentation: EvmSignerPresentation


@runtime_checkable
class EvmSigner(Protocol):
    """Caller-owned signer. It accepts a human-readable presentation, never a key."""

    kind: Literal["evm"]

    def get_address(self) -> str: ...

    def sign_typed_data(self, request: EvmTypedDataRequest) -> bytes | str: ...


@dataclass(frozen=True, slots=True)
class ExactEvmPlan:
    chain_id: int
    verifying_contract: str
    domain_name: str
    domain_version: str
    payer: str
    recipient: str
    value_atomic: str
    lifetime_seconds: int
    valid_after_seconds: int
    not_before_epoch_seconds: int
    not_after_epoch_seconds: int
    balance_of_call_data: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "chainId": self.chain_id,
            "verifyingContract": self.verifying_contract,
            "domainName": self.domain_name,
            "domainVersion": self.domain_version,
            "payer": self.payer,
            "recipient": self.recipient,
            "valueAtomic": self.value_atomic,
            "lifetimeSeconds": self.lifetime_seconds,
            "validAfterSeconds": self.valid_after_seconds,
            "notBeforeEpochSeconds": self.not_before_epoch_seconds,
            "notAfterEpochSeconds": self.not_after_epoch_seconds,
            "balanceOfCallData": self.balance_of_call_data,
        }


def _invalid(
    reason: str, schema_path: str, context: Tx402ErrorContext
) -> InvalidPaymentRequiredError:
    return InvalidPaymentRequiredError(
        f"Base payment requirement is unusable: {reason}",
        context=context,
        details={"reason": reason, "schemaPath": schema_path},
    )


def encode_balance_of_call_data(owner: str) -> str:
    if _ADDRESS.fullmatch(owner) is None:
        raise TypeError("balanceOf owner must be a 20-byte hex address")
    return f"{BALANCE_OF_SELECTOR}{owner[2:].lower().rjust(64, '0')}"


def plan_exact_evm_authorization(
    *,
    requirement: Mapping[str, Any],
    network_id: str,
    network: Mapping[str, Any],
    asset: Mapping[str, Any],
    payer: str,
    now_epoch_ms: int,
    max_authorization_seconds: int = MAX_AUTHORIZATION_SECONDS,
    context: Tx402ErrorContext,
) -> ExactEvmPlan:
    """Pure derivation of the EIP-3009 authorization tx402 is willing to sign."""
    if requirement["scheme"] != "exact":
        raise UnsupportedSchemeError(
            "Base supports only the exact payment scheme",
            context=context,
            details={
                "offeredSchemes": [requirement["scheme"]],
                "offeredNetworks": [requirement["network"]],
                "reason": "scheme-unsupported",
            },
        )
    extra: Mapping[str, Any] = requirement["extra"]
    transfer_method = extra.get("assetTransferMethod")
    if transfer_method is not None and transfer_method != SUPPORTED_ASSET_TRANSFER_METHOD:
        raise UnsupportedSchemeError(
            "Asset transfer method is not supported in v0.1",
            context=context,
            details={
                "offeredSchemes": [requirement["scheme"]],
                "offeredNetworks": [requirement["network"]],
                "reason": "asset-transfer-method-unsupported",
            },
        )
    chain_id = network.get("chainId")
    if isinstance(chain_id, bool) or not isinstance(chain_id, int):
        raise _invalid("network-chain-id-mismatch", "/accepts/*/network", context)
    if network_id != f"eip155:{chain_id}":
        raise _invalid("network-chain-id-mismatch", "/accepts/*/network", context)
    if requirement["network"] != network_id:
        raise _invalid("network-not-canonical", "/accepts/*/network", context)
    address = asset.get("address")
    if not isinstance(address, str) or address.lower() != requirement["asset"].lower():
        raise _invalid("asset-not-manifest-asset", "/accepts/*/asset", context)
    if _ADDRESS.fullmatch(requirement["payTo"]) is None:
        raise _invalid("pay-to-invalid", "/accepts/*/payTo", context)
    if _ADDRESS.fullmatch(address) is None:
        raise _invalid("asset-address-invalid", "/accepts/*/asset", context)
    if _ADDRESS.fullmatch(payer) is None:
        raise _invalid("payer-invalid", "/accepts/*/payTo", context)
    domain_name, domain_version = extra.get("name"), extra.get("version")
    if (
        not isinstance(domain_name, str)
        or not domain_name
        or not isinstance(domain_version, str)
        or not domain_version
    ):
        raise _invalid("eip712-domain-missing", "/accepts/*/extra", context)
    declared_version = asset.get("eip712Version")
    if declared_version is not None and declared_version != domain_version:
        raise _invalid("eip712-domain-mismatch", "/accepts/*/extra/version", context)
    timeout = requirement["maxTimeoutSeconds"]
    if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 1:
        raise _invalid("max-timeout-invalid", "/accepts/*/maxTimeoutSeconds", context)
    amount = requirement["amountAtomic"]
    if not isinstance(amount, str) or re.fullmatch(r"[1-9][0-9]*", amount) is None:
        raise _invalid("amount-not-atomic-integer", "/accepts/*/amount", context)
    lifetime = min(max_authorization_seconds, timeout)
    now_seconds = now_epoch_ms // 1_000
    return ExactEvmPlan(
        chain_id,
        address,
        domain_name,
        domain_version,
        payer,
        requirement["payTo"],
        amount,
        lifetime,
        0,
        now_seconds,
        now_seconds + lifetime,
        encode_balance_of_call_data(payer),
    )


EvmRpcFailure = Literal[
    "chain-id-mismatch",
    "chain-id-unreadable",
    "balance-unreadable",
    "transport",
    "timeout",
    "protocol",
]


class EvmRpcError(Exception):
    def __init__(self, failure: EvmRpcFailure, message: str) -> None:
        super().__init__(message)
        self.failure = failure


@dataclass(frozen=True, slots=True)
class EvmBalanceReading:
    balance_atomic: int
    chain_id: int
    endpoint: str


T = TypeVar("T")


def _with_deadline(call: Callable[[], T], timeout_ms: int) -> T:
    """Race a sync operation on a daemon thread; the SDK owns the deadline."""
    result: queue.Queue[tuple[bool, object]] = queue.Queue(maxsize=1)

    def run() -> None:
        try:
            result.put((True, call()))
        except BaseException as error:
            result.put((False, error))

    threading.Thread(target=run, daemon=True).start()
    try:
        succeeded, value = result.get(timeout=timeout_ms / 1_000)
    except queue.Empty as error:
        raise TimeoutError("tx402 operation deadline elapsed") from error
    if succeeded:
        return value  # type: ignore[return-value]
    raise value  # type: ignore[misc]


async def _with_deadline_async(awaitable: Awaitable[T], timeout_ms: int) -> T:
    """Race an async operation without relying on its cancellation propagation."""
    operation = asyncio.ensure_future(awaitable)
    done, _ = await asyncio.wait({operation}, timeout=timeout_ms / 1_000)
    if operation not in done:
        operation.cancel()

        def consume_result(completed: asyncio.Future[T]) -> None:
            with suppress(BaseException):
                completed.result()

        operation.add_done_callback(consume_result)
        raise TimeoutError("tx402 operation deadline elapsed")
    return operation.result()


class EvmRpcPool:
    """At most two manifest RPCs; chain identity is checked before every balance read."""

    def __init__(
        self,
        rpc_urls: Sequence[str],
        *,
        transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
        timeout_ms: int = RPC_TIMEOUT_MS,
    ) -> None:
        self._urls = tuple(rpc_urls[:MAX_PROVIDERS_PER_NETWORK])
        self._transport = transport
        if (
            isinstance(timeout_ms, bool)
            or not isinstance(timeout_ms, int)
            or timeout_ms <= 0
        ):
            raise TypeError("timeout_ms must be a positive integer")
        self._timeout_ms = timeout_ms
        self._request_id = 0

    def _payload(self, method: str, params: list[Any]) -> dict[str, Any]:
        self._request_id += 1
        return {
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
            "params": params,
        }

    @staticmethod
    def _result(response: httpx.Response, method: str) -> Any:
        if not response.is_success:
            raise EvmRpcError("transport", f"{method} returned an HTTP error")
        try:
            document = response.json()
        except ValueError as error:
            raise EvmRpcError("protocol", f"{method} returned non-JSON") from error
        if (
            not isinstance(document, dict)
            or "error" in document
            or "result" not in document
        ):
            raise EvmRpcError("protocol", f"{method} returned an invalid envelope")
        return document["result"]

    def _call(self, client: httpx.Client, url: str, method: str, params: list[Any]) -> Any:
        try:
            response = _with_deadline(
                lambda: client.post(url, json=self._payload(method, params)),
                self._timeout_ms,
            )
        except TimeoutError as error:
            raise EvmRpcError("timeout", f"{method} timed out") from error
        except httpx.HTTPError as error:
            raise EvmRpcError("transport", f"{method} failed") from error
        return self._result(response, method)

    async def _call_async(
        self, client: httpx.AsyncClient, url: str, method: str, params: list[Any]
    ) -> Any:
        try:
            response = await _with_deadline_async(
                client.post(url, json=self._payload(method, params)),
                self._timeout_ms,
            )
        except TimeoutError as error:
            raise EvmRpcError("timeout", f"{method} timed out") from error
        except httpx.HTTPError as error:
            raise EvmRpcError("transport", f"{method} failed") from error
        return self._result(response, method)

    @staticmethod
    def _chain_id(raw: Any) -> int:
        if not isinstance(raw, str) or _QUANTITY.fullmatch(raw) is None:
            raise EvmRpcError("chain-id-unreadable", "RPC returned a malformed chain ID")
        value = int(raw, 16)
        if value <= 0:
            raise EvmRpcError("chain-id-unreadable", "RPC returned an invalid chain ID")
        return value

    @staticmethod
    def _balance(raw: Any) -> int:
        if raw == "0x":
            return 0
        if not isinstance(raw, str) or re.fullmatch(r"0x[0-9a-fA-F]{1,64}", raw) is None:
            raise EvmRpcError("balance-unreadable", "RPC returned a malformed balance")
        return int(raw, 16)

    def read_balance(self, *, chain_id: int, token: str, owner: str) -> EvmBalanceReading:
        if _ADDRESS.fullmatch(token) is None or _ADDRESS.fullmatch(owner) is None:
            raise EvmRpcError("protocol", "Token and owner must be 20-byte addresses")
        if not self._urls:
            raise EvmRpcError("transport", "No RPC endpoint is configured")
        last: EvmRpcError = EvmRpcError("transport", "No RPC endpoint answered")
        sync_transport = self._transport
        if sync_transport is not None and not isinstance(
            sync_transport, httpx.BaseTransport
        ):
            raise TypeError("Sync balance reads require an httpx.BaseTransport")
        with httpx.Client(transport=sync_transport) as client:
            for url in self._urls:
                try:
                    observed = self._chain_id(self._call(client, url, "eth_chainId", []))
                    if observed != chain_id:
                        last = EvmRpcError("chain-id-mismatch", "RPC serves another chain")
                        continue
                    raw = self._call(
                        client,
                        url,
                        "eth_call",
                        [
                            {"to": token, "data": encode_balance_of_call_data(owner)},
                            "latest",
                        ],
                    )
                    return EvmBalanceReading(self._balance(raw), observed, _safe_host(url))
                except EvmRpcError as error:
                    last = error
        raise last

    async def read_balance_async(
        self, *, chain_id: int, token: str, owner: str
    ) -> EvmBalanceReading:
        if _ADDRESS.fullmatch(token) is None or _ADDRESS.fullmatch(owner) is None:
            raise EvmRpcError("protocol", "Token and owner must be 20-byte addresses")
        if not self._urls:
            raise EvmRpcError("transport", "No RPC endpoint is configured")
        last: EvmRpcError = EvmRpcError("transport", "No RPC endpoint answered")
        async_transport = self._transport
        if async_transport is not None and not isinstance(
            async_transport, httpx.AsyncBaseTransport
        ):
            raise TypeError("Async balance reads require an httpx.AsyncBaseTransport")
        async with httpx.AsyncClient(transport=async_transport) as client:
            for url in self._urls:
                try:
                    observed = self._chain_id(
                        await self._call_async(client, url, "eth_chainId", [])
                    )
                    if observed != chain_id:
                        last = EvmRpcError("chain-id-mismatch", "RPC serves another chain")
                        continue
                    raw = await self._call_async(
                        client,
                        url,
                        "eth_call",
                        [
                            {"to": token, "data": encode_balance_of_call_data(owner)},
                            "latest",
                        ],
                    )
                    return EvmBalanceReading(self._balance(raw), observed, _safe_host(url))
                except EvmRpcError as error:
                    last = error
        raise last


def _safe_host(url: str) -> str:
    try:
        return httpx.URL(url).netloc.decode()
    except Exception:
        return "invalid-rpc-url"


def resolve_evm_address(signer: EvmSigner, context: Tx402ErrorContext) -> str:
    try:
        address = signer.get_address()
    except BaseException as error:
        raise SignerError(
            "Signer address lookup failed",
            context=context,
            details={"signerKind": "evm", "causeCategory": "address-unavailable"},
            cause=error,
        ) from error
    if not isinstance(address, str) or _ADDRESS.fullmatch(address) is None:
        raise SignerError(
            "Signer returned a malformed EVM address",
            context=context,
            details={"signerKind": "evm", "causeCategory": "address-unavailable"},
        )
    return address


class _UpstreamSigner:
    def __init__(
        self,
        *,
        signer: EvmSigner,
        address: str,
        plan: ExactEvmPlan,
        presentation: Mapping[str, str],
        context: Tx402ErrorContext,
    ) -> None:
        self.address = address
        self._signer = signer
        self._plan = plan
        self._presentation = presentation
        self._context = context
        self.sign_count = 0
        self.expires_at_epoch_ms = 0

    def _failure(
        self, message: str, category: str, cause: BaseException | None = None
    ) -> SignerError:
        return SignerError(
            message,
            context=self._context,
            details={"signerKind": "evm", "causeCategory": category},
            cause=cause,
        )

    def sign_typed_data(
        self,
        domain: Any,
        types: Mapping[str, Sequence[Any]],
        primary_type: str,
        message: Mapping[str, Any],
    ) -> bytes:
        if self.sign_count:
            raise self._failure(
                "Scheme requested more than one signature", "duplicate-signature-request"
            )
        if hasattr(domain, "model_dump"):
            domain_dict = domain.model_dump(by_alias=True, exclude_none=True)
        elif hasattr(domain, "__dataclass_fields__"):
            domain_dict = {
                "name": domain.name,
                "version": domain.version,
                "chainId": domain.chain_id,
                "verifyingContract": domain.verifying_contract,
            }
        else:
            domain_dict = dict(domain)
        if primary_type != "TransferWithAuthorization":
            raise self._failure("Unexpected EIP-712 primary type", "plan-mismatch")
        plan = self._plan
        if domain_dict.get("chainId") != plan.chain_id:
            raise self._failure("EIP-712 chain ID changed", "plan-mismatch")
        contract = domain_dict.get("verifyingContract")
        if (
            not isinstance(contract, str)
            or contract.lower() != plan.verifying_contract.lower()
        ):
            raise self._failure("EIP-712 verifying contract changed", "plan-mismatch")
        if (
            domain_dict.get("name") != plan.domain_name
            or domain_dict.get("version") != plan.domain_version
        ):
            raise self._failure("EIP-712 token domain changed", "plan-mismatch")
        if not _same_address(message.get("from"), plan.payer):
            raise self._failure("Authorization payer changed", "plan-mismatch")
        if not _same_address(message.get("to"), plan.recipient):
            raise self._failure("Authorization recipient changed", "plan-mismatch")
        if _quantity(message.get("value"), self._context) != int(plan.value_atomic):
            raise self._failure("Authorization amount changed", "plan-mismatch")
        if _quantity(message.get("validAfter"), self._context) != 0:
            raise self._failure("Authorization is not valid immediately", "plan-mismatch")
        valid_before = _quantity(message.get("validBefore"), self._context)
        now_seconds = time.time_ns() // 1_000_000_000
        if (
            valid_before <= now_seconds
            or valid_before > now_seconds + plan.lifetime_seconds
        ):
            raise self._failure("Authorization lifetime changed", "plan-mismatch")
        nonce = message.get("nonce")
        nonce_valid = (isinstance(nonce, bytes) and len(nonce) == 32) or (
            isinstance(nonce, str) and _NONCE.fullmatch(nonce) is not None
        )
        if not nonce_valid:
            raise self._failure("Authorization nonce is not 32 bytes", "plan-mismatch")
        narrowed_types = {
            name: tuple(_typed_field(field, self._context) for field in fields)
            for name, fields in types.items()
        }
        self.sign_count += 1
        self.expires_at_epoch_ms = valid_before * 1_000
        request = EvmTypedDataRequest(
            domain_dict,
            narrowed_types,
            primary_type,
            dict(message),
            EvmSignerPresentation(
                network=self._presentation["network"],
                asset_id=self._presentation["assetId"],
                asset_symbol=self._presentation["assetSymbol"],
                amount_atomic=plan.value_atomic,
                amount_decimal=self._presentation["amountDecimal"],
                recipient=plan.recipient,
                resource_host=self._presentation["resourceHost"],
                domain_name=plan.domain_name,
                expires_at=time.strftime(
                    "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(valid_before)
                ),
                request_hash=self._presentation["requestHash"],
            ),
        )
        try:
            signature = self._signer.sign_typed_data(request)
        except BaseException as error:
            raise self._failure(
                "Signer rejected the authorization", "signer-rejected", error
            ) from error
        if isinstance(signature, str):
            if re.fullmatch(r"0x[0-9a-fA-F]+", signature) is None:
                raise self._failure(
                    "Signer returned a malformed signature", "malformed-signature"
                )
            return bytes.fromhex(signature[2:])
        if not isinstance(signature, bytes) or not signature:
            raise self._failure(
                "Signer returned a malformed signature", "malformed-signature"
            )
        return signature


def _same_address(value: object, expected: str) -> bool:
    return isinstance(value, str) and value.lower() == expected.lower()


def _quantity(value: object, context: Tx402ErrorContext) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]*)", value):
        return int(value)
    raise SignerError(
        "Authorization quantity is malformed",
        context=context,
        details={"signerKind": "evm", "causeCategory": "plan-mismatch"},
    )


def _typed_field(field: Any, context: Tx402ErrorContext) -> Mapping[str, str]:
    if hasattr(field, "model_dump"):
        field = field.model_dump()
    elif hasattr(field, "__dataclass_fields__"):
        field = {"name": field.name, "type": field.type}
    if (
        isinstance(field, Mapping)
        and isinstance(field.get("name"), str)
        and isinstance(field.get("type"), str)
    ):
        return {"name": field["name"], "type": field["type"]}
    raise SignerError(
        "Authorization typed-data definition is malformed",
        context=context,
        details={"signerKind": "evm", "causeCategory": "plan-mismatch"},
    )


def create_evm_authorization(
    *,
    signer: EvmSigner,
    address: str,
    plan: ExactEvmPlan,
    requirement: Mapping[str, Any],
    asset: Mapping[str, Any],
    resource_host: str,
    request_hash: str,
    context: Tx402ErrorContext,
) -> tuple[dict[str, Any], int]:
    """Ask upstream to build EIP-3009, enforcing the approved plan at the key boundary."""
    # Optional dependency boundary: importing ``tx402`` stays core-only. The audited
    # upstream EVM implementation is loaded only when an EVM authorization is created.
    try:
        from x402.mechanisms.evm.exact.client import ExactEvmScheme
    except ImportError as error:
        raise SignerError(
            "EVM support is not installed",
            context=context,
            details={"signerKind": "evm", "causeCategory": "evm-extra-missing"},
            cause=error,
        ) from error

    adapter = _UpstreamSigner(
        signer=signer,
        address=address,
        plan=plan,
        presentation={
            "network": requirement["network"],
            "assetId": f"{requirement['network']}/erc20:{asset['address']}",
            "assetSymbol": asset["symbol"],
            "amountDecimal": format_money_decimal(plan.value_atomic, asset["decimals"]),
            "resourceHost": resource_host,
            "requestHash": request_hash,
        },
        context=context,
    )
    clamped = PaymentRequirements.model_validate(
        {
            "scheme": requirement["scheme"],
            "network": requirement["network"],
            "asset": requirement["asset"],
            "amount": requirement["amountAtomic"],
            "payTo": requirement["payTo"],
            "maxTimeoutSeconds": plan.lifetime_seconds,
            "extra": dict(requirement["extra"]),
        }
    )
    try:
        payload = ExactEvmScheme(adapter).create_payment_payload(clamped)
    except SignerError:
        raise
    except BaseException as error:
        raise SignerError(
            "Failed to create the Base payment authorization",
            context=context,
            details={"signerKind": "evm", "causeCategory": "payload-creation-failed"},
            cause=error,
        ) from error
    if adapter.sign_count != 1 or not payload:
        raise SignerError(
            "Scheme did not produce exactly one authorization",
            context=context,
            details={"signerKind": "evm", "causeCategory": "unexpected-signature-count"},
        )
    return payload, adapter.expires_at_epoch_ms
