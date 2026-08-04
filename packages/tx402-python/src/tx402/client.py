"""tx402-owned synchronous and asynchronous HTTPX transports (SPEC §4.2, §6)."""

from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final, TypeVar

import httpx
from x402.http.utils import (
    decode_payment_response_header,
    encode_payment_signature_header,
)
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

from tx402.bundled_manifest import BUNDLED_MANIFEST
from tx402.errors import (
    AmbiguousPaymentError,
    ConfigurationError,
    InsufficientLiquidityError,
    NonReplayableRequestError,
    ReservedHeaderError,
    ResourceDeliveryError,
    TransportError,
    Tx402ErrorContext,
    UnsupportedSchemeError,
)
from tx402.evm import (
    EvmRpcError,
    EvmRpcPool,
    EvmSigner,
    _with_deadline,
    _with_deadline_async,
    create_evm_authorization,
    plan_exact_evm_authorization,
    resolve_evm_address,
)
from tx402.fingerprint import fingerprint_request
from tx402.ledger import BudgetState, MemorySpendStore
from tx402.manifest import assert_valid_release_manifest
from tx402.meta import PROTOCOL_HEADERS, REQUEST_ID_HEADER, RESERVED_REQUEST_HEADERS
from tx402.policy import (
    Policy,
    PolicyDecision,
    PolicyEngine,
    PolicyRequirement,
    RoutingPolicy,
)
from tx402.protocol import decode_payment_required

BodyFactory = Callable[[], bytes | str]
Clock = Callable[[], int]
_BODY_FACTORY_EXTENSION: Final = "tx402.body_factory"
_PAYMENT_RETRY_TIMEOUT_MS: Final = 10_000
_MIN_PAYMENT_RETRY_TIMEOUT_MS: Final = 1_000


@dataclass(frozen=True, slots=True)
class PaymentInspection:
    request_id: str
    response: httpx.Response
    payment_required: Mapping[str, Any] | None


def _system_clock() -> int:
    return time.time_ns() // 1_000_000


def _request_id(now_epoch_ms: int) -> str:
    """UUIDv7-compatible diagnostic ID without depending on Python 3.14's uuid7."""
    timestamp = now_epoch_ms & ((1 << 48) - 1)
    random = secrets.randbits(74)
    value = (
        (timestamp << 80)
        | (0x7 << 76)
        | (((random >> 62) & 0xFFF) << 64)
        | (0b10 << 62)
        | (random & ((1 << 62) - 1))
    )
    text = f"{value:032x}"
    return f"{text[:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:]}"


def _configuration(path: str, reason: str) -> ConfigurationError:
    return ConfigurationError(
        f"Invalid {path}: {reason}",
        context=Tx402ErrorContext(request_id="configuration", phase="initial"),
        details={"configPath": path, "reason": reason},
    )


def _assert_url(request: httpx.Request, allow_insecure_localhost: bool) -> None:
    if request.url.scheme == "https":
        return
    host = request.url.host.lower()
    if (
        allow_insecure_localhost
        and request.url.scheme == "http"
        and host
        in {
            "localhost",
            "127.0.0.1",
            "::1",
        }
    ):
        return
    raise _configuration("url", "https-required")


def _assert_headers(request: httpx.Request, request_id: str) -> None:
    for header in RESERVED_REQUEST_HEADERS:
        if header in request.headers:
            raise ReservedHeaderError(
                f"Caller supplied reserved header {header}",
                context=Tx402ErrorContext(request_id=request_id, phase="initial"),
                details={"headerName": header},
            )


def _capture_body(request: httpx.Request, request_id: str) -> bytes:
    body_factory = request.extensions.get(_BODY_FACTORY_EXTENSION)
    if not isinstance(request.stream, httpx.ByteStream) and body_factory is None:
        raise NonReplayableRequestError(
            "Streaming request body cannot be replayed",
            context=Tx402ErrorContext(request_id=request_id, phase="initial"),
            details={"reason": "stream-without-body-factory"},
        )
    return request.read()


async def _capture_body_async(request: httpx.Request, request_id: str) -> bytes:
    body_factory = request.extensions.get(_BODY_FACTORY_EXTENSION)
    if not isinstance(request.stream, httpx.ByteStream) and body_factory is None:
        raise NonReplayableRequestError(
            "Streaming request body cannot be replayed",
            context=Tx402ErrorContext(request_id=request_id, phase="initial"),
            details={"reason": "stream-without-body-factory"},
        )
    return await request.aread()


def _fresh_body(request: httpx.Request, captured: bytes, request_id: str) -> bytes:
    factory = request.extensions.get(_BODY_FACTORY_EXTENSION)
    if factory is None:
        return captured
    try:
        value = factory()
    except BaseException as error:
        raise NonReplayableRequestError(
            "body_factory failed while preparing the paid retry",
            context=Tx402ErrorContext(request_id=request_id, phase="retry"),
            details={"reason": "body-factory-failed"},
            cause=error,
        ) from error
    if isinstance(value, str):
        return value.encode()
    if isinstance(value, bytes):
        return value
    raise NonReplayableRequestError(
        "body_factory must return bytes or str",
        context=Tx402ErrorContext(request_id=request_id, phase="retry"),
        details={"reason": "body-factory-invalid"},
    )


def _payment_requirements(requirement: Mapping[str, Any]) -> PaymentRequirements:
    return PaymentRequirements.model_validate(
        {
            "scheme": requirement["scheme"],
            "network": requirement["network"],
            "asset": requirement["asset"],
            "amount": requirement["amountAtomic"],
            "payTo": requirement["payTo"],
            "maxTimeoutSeconds": requirement["maxTimeoutSeconds"],
            "extra": dict(requirement["extra"]),
        }
    )


def _retry_request(
    request: httpx.Request, body: bytes, signature: str, request_id: str
) -> httpx.Request:
    headers = request.headers.copy()
    headers[PROTOCOL_HEADERS["payment_signature"]] = signature
    headers[REQUEST_ID_HEADER] = request_id
    return httpx.Request(
        request.method,
        request.url,
        headers=headers,
        content=body,
        extensions=request.extensions,
    )


def _transport_error(error: BaseException, request_id: str, phase: str) -> TransportError:
    return TransportError(
        "HTTP transport failed",
        context=Tx402ErrorContext(request_id=request_id, phase=phase),  # type: ignore[arg-type]
        details={"causeCategory": "transport"},
        cause=error,
    )


class _Core:
    def __init__(
        self,
        *,
        evm_signer: EvmSigner | None,
        policy: PolicyEngine,
        spend_store: MemorySpendStore,
        manifest: Mapping[str, Any],
        clock: Clock,
        rpc_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None,
        allow_insecure_localhost: bool,
        payment_retry_timeout_ms: int,
    ) -> None:
        self.evm_signer = evm_signer
        self.policy = policy
        self.spend_store = spend_store
        self.manifest = manifest
        self.clock = clock
        self.rpc_transport = rpc_transport
        self.allow_insecure_localhost = allow_insecure_localhost
        self.payment_retry_timeout_ms = payment_retry_timeout_ms

    def prepare(self, request: httpx.Request, request_id: str) -> tuple[bytes, str]:
        _assert_url(request, self.allow_insecure_localhost)
        _assert_headers(request, request_id)
        host = self.policy.assert_domain(str(request.url), request_id)
        return _capture_body(request, request_id), host

    async def prepare_async(
        self, request: httpx.Request, request_id: str
    ) -> tuple[bytes, str]:
        _assert_url(request, self.allow_insecure_localhost)
        _assert_headers(request, request_id)
        host = self.policy.assert_domain(str(request.url), request_id)
        return await _capture_body_async(request, request_id), host

    def decode(
        self, response: httpx.Response, request: httpx.Request, request_id: str
    ) -> Mapping[str, Any]:
        return decode_payment_required(
            response.headers.get(PROTOCOL_HEADERS["payment_required"]),
            request_url=str(request.url),
            request_method=request.method,
            request_id=request_id,
            clock_epoch_ms=self.clock(),
        )

    def decide(
        self, payment_required: Mapping[str, Any], request_id: str, host: str
    ) -> PolicyDecision:
        return self.policy.evaluate(
            payment_required,
            request_id=request_id,
            policy_scope=host,
            now_epoch_ms=self.clock(),
            spend_store=self.spend_store,
        )

    def evm_inputs(
        self, decision: PolicyDecision, request_id: str
    ) -> tuple[PolicyRequirement, Mapping[str, Any], Mapping[str, Any], str, Any]:
        if self.evm_signer is None:
            raise UnsupportedSchemeError(
                "No configured signer can authorize the offered routes",
                context=Tx402ErrorContext(request_id=request_id, phase="route"),
                details={
                    "offeredSchemes": [
                        item.requirement["scheme"] for item in decision.requirements
                    ],
                    "offeredNetworks": [
                        item.requirement["network"] for item in decision.requirements
                    ],
                },
            )
        item = next(
            (
                candidate
                for candidate in decision.requirements
                if candidate.requirement["network"].startswith("eip155:")
            ),
            None,
        )
        if item is None:
            raise UnsupportedSchemeError(
                "Python M3 supports only EVM routes",
                context=Tx402ErrorContext(request_id=request_id, phase="route"),
                details={
                    "offeredSchemes": [
                        candidate.requirement["scheme"]
                        for candidate in decision.requirements
                    ],
                    "offeredNetworks": [
                        candidate.requirement["network"]
                        for candidate in decision.requirements
                    ],
                },
            )
        requirement = item.requirement
        network = self.manifest["networks"][requirement["network"]]
        asset = item.manifest_asset
        context = Tx402ErrorContext(
            request_id=request_id,
            phase="route",
            network=requirement["network"],
            scheme=requirement["scheme"],
            amount_atomic=requirement["amountAtomic"],
            asset_id=item.asset_id,
        )
        address = resolve_evm_address(self.evm_signer, context)
        plan = plan_exact_evm_authorization(
            requirement=requirement,
            network_id=requirement["network"],
            network=network,
            asset=asset,
            payer=address,
            now_epoch_ms=self.clock(),
            context=context,
        )
        return item, network, asset, address, plan

    def reserve_and_sign(
        self,
        *,
        request: httpx.Request,
        captured_body: bytes,
        host: str,
        request_id: str,
        item: PolicyRequirement,
        asset: Mapping[str, Any],
        address: str,
        plan: Any,
        challenge_hash: str,
    ) -> tuple[str, str, int]:
        requirement = item.requirement
        now = self.clock()
        reservation_id = _request_id(now)
        request_hash = fingerprint_request(
            method=request.method,
            url=str(request.url),
            body=captured_body,
            challenge_hash=challenge_hash,
        )
        reservation = self.spend_store.reserve(
            reservation_id=reservation_id,
            request_id=request_id,
            policy_scope=host,
            request_fingerprint=request_hash,
            asset_id=item.asset_id,
            amount_atomic=requirement["amountAtomic"],
            max_per_hour_atomic=item.max_per_hour_atomic,
            now_epoch_ms=now,
        )
        sign_context = Tx402ErrorContext(
            request_id=request_id,
            phase="sign",
            network=requirement["network"],
            scheme=requirement["scheme"],
            amount_atomic=requirement["amountAtomic"],
            asset_id=item.asset_id,
            reservation_id=reservation_id,
        )
        try:
            payload, expires = create_evm_authorization(
                signer=self.evm_signer,  # type: ignore[arg-type]
                address=address,
                plan=plan,
                requirement=requirement,
                asset=asset,
                resource_host=host,
                request_hash=request_hash,
                context=sign_context,
            )
        except BaseException:
            self.spend_store.release(
                reservation_id=reservation_id, now_epoch_ms=self.clock()
            )
            raise
        outer = PaymentPayload(
            x402_version=2,
            payload=payload,
            accepted=_payment_requirements(requirement),
            resource=ResourceInfo(url=str(request.url)),
        )
        return encode_payment_signature_header(outer), reservation.reservation_id, expires

    def complete(
        self,
        response: httpx.Response,
        *,
        request_id: str,
        reservation_id: str,
        reservation_expires: int,
    ) -> httpx.Response:
        if 200 <= response.status_code < 300:
            settlement_id: str | None = None
            payment_response = response.headers.get(PROTOCOL_HEADERS["payment_response"])
            if payment_response:
                try:
                    settlement = decode_payment_response_header(payment_response)
                except (ValueError, TypeError):
                    settlement = None
                if settlement is not None:
                    if not settlement.success:
                        self.spend_store.release(
                            reservation_id=reservation_id, now_epoch_ms=self.clock()
                        )
                        raise ResourceDeliveryError(
                            "Merchant reported unsuccessful settlement",
                            context=Tx402ErrorContext(
                                request_id=request_id, phase="complete", paid=False
                            ),
                            details={
                                "status": response.status_code,
                                "reason": "settlement-unsuccessful",
                            },
                        )
                    settlement_id = settlement.transaction
            self.spend_store.commit(
                reservation_id=reservation_id,
                committed_at_epoch_ms=self.clock(),
                settlement_id=settlement_id,
            )
            return response
        if 300 <= response.status_code < 400 or response.status_code >= 500:
            raise AmbiguousPaymentError(
                "Paid request outcome is ambiguous",
                context=Tx402ErrorContext(
                    request_id=request_id,
                    phase="complete",
                    paid="unknown",
                    reservation_id=reservation_id,
                ),
                details={
                    "reservationExpiresAtEpochMs": reservation_expires,
                    "causeCategory": (
                        "redirect-not-followed"
                        if response.status_code < 400
                        else "merchant-server-error"
                    ),
                },
            )
        self.spend_store.release(reservation_id=reservation_id, now_epoch_ms=self.clock())
        raise ResourceDeliveryError(
            "Merchant refused the paid request",
            context=Tx402ErrorContext(request_id=request_id, phase="complete", paid=False),
            details={"status": response.status_code, "reason": "merchant-refused"},
        )


class Tx402Transport(httpx.BaseTransport):
    """Synchronous HTTPX transport implementing the tx402 M1-M3 request path."""

    def __init__(self, inner: httpx.BaseTransport, core: _Core) -> None:
        self._inner = inner
        self._core = core

    def inspect(self, request: httpx.Request) -> PaymentInspection:
        request_id = _request_id(self._core.clock())
        self._core.prepare(request, request_id)
        try:
            response = self._inner.handle_request(request)
        except httpx.HTTPError as error:
            raise _transport_error(error, request_id, "initial") from error
        if response.status_code != 402:
            return PaymentInspection(request_id, response, None)
        response.read()
        return PaymentInspection(
            request_id, response, self._core.decode(response, request, request_id)
        )

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        request_id = _request_id(self._core.clock())
        body, host = self._core.prepare(request, request_id)
        try:
            response = self._inner.handle_request(request)
        except httpx.HTTPError as error:
            raise _transport_error(error, request_id, "initial") from error
        if response.status_code != 402:
            return response
        response.read()
        payment_required = self._core.decode(response, request, request_id)
        decision = self._core.decide(payment_required, request_id, host)
        item, network, asset, address, plan = self._core.evm_inputs(decision, request_id)
        pool = EvmRpcPool(network["rpcUrls"], transport=self._core.rpc_transport)
        try:
            reading = pool.read_balance(
                chain_id=plan.chain_id,
                token=plan.verifying_contract,
                owner=address,
            )
        except EvmRpcError as error:
            raise TransportError(
                "Base RPC is unavailable for route planning",
                context=Tx402ErrorContext(request_id=request_id, phase="route"),
                details={"causeCategory": error.failure},
                cause=error,
            ) from error
        if reading.balance_atomic < int(item.requirement["amountAtomic"]):
            raise InsufficientLiquidityError(
                "No offered route has sufficient balance",
                context=Tx402ErrorContext(request_id=request_id, phase="route"),
                details={
                    "deficits": [
                        {
                            "network": item.requirement["network"],
                            "requiredAtomic": item.requirement["amountAtomic"],
                            "availableAtomic": str(reading.balance_atomic),
                        }
                    ]
                },
            )
        signature, reservation_id, expires = self._core.reserve_and_sign(
            request=request,
            captured_body=body,
            host=host,
            request_id=request_id,
            item=item,
            asset=asset,
            address=address,
            plan=plan,
            challenge_hash=payment_required["headerHash"],
        )
        retry = _retry_request(
            request, _fresh_body(request, body, request_id), signature, request_id
        )
        try:
            paid = _with_deadline(
                lambda: self._inner.handle_request(retry),
                self._core.payment_retry_timeout_ms,
            )
        except TimeoutError as error:
            raise AmbiguousPaymentError(
                "Paid request timed out",
                context=Tx402ErrorContext(
                    request_id=request_id,
                    phase="retry",
                    paid="unknown",
                    reservation_id=reservation_id,
                ),
                details={
                    "reservationExpiresAtEpochMs": expires,
                    "causeCategory": "timeout",
                },
                cause=error,
            ) from error
        except httpx.HTTPError as error:
            raise AmbiguousPaymentError(
                "Paid request transport failed",
                context=Tx402ErrorContext(
                    request_id=request_id,
                    phase="retry",
                    paid="unknown",
                    reservation_id=reservation_id,
                ),
                details={
                    "reservationExpiresAtEpochMs": expires,
                    "causeCategory": "transport",
                },
                cause=error,
            ) from error
        return self._core.complete(
            paid,
            request_id=request_id,
            reservation_id=reservation_id,
            reservation_expires=expires,
        )

    def close(self) -> None:
        self._inner.close()


class AsyncTx402Transport(httpx.AsyncBaseTransport):
    """Asynchronous counterpart to :class:`Tx402Transport`."""

    def __init__(self, inner: httpx.AsyncBaseTransport, core: _Core) -> None:
        self._inner = inner
        self._core = core

    async def inspect(self, request: httpx.Request) -> PaymentInspection:
        request_id = _request_id(self._core.clock())
        await self._core.prepare_async(request, request_id)
        try:
            response = await self._inner.handle_async_request(request)
        except httpx.HTTPError as error:
            raise _transport_error(error, request_id, "initial") from error
        if response.status_code != 402:
            return PaymentInspection(request_id, response, None)
        await response.aread()
        return PaymentInspection(
            request_id, response, self._core.decode(response, request, request_id)
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        request_id = _request_id(self._core.clock())
        body, host = await self._core.prepare_async(request, request_id)
        try:
            response = await self._inner.handle_async_request(request)
        except httpx.HTTPError as error:
            raise _transport_error(error, request_id, "initial") from error
        if response.status_code != 402:
            return response
        await response.aread()
        payment_required = self._core.decode(response, request, request_id)
        decision = self._core.decide(payment_required, request_id, host)
        item, network, asset, address, plan = await asyncio.to_thread(
            self._core.evm_inputs, decision, request_id
        )
        pool = EvmRpcPool(network["rpcUrls"], transport=self._core.rpc_transport)
        try:
            reading = await pool.read_balance_async(
                chain_id=plan.chain_id,
                token=plan.verifying_contract,
                owner=address,
            )
        except EvmRpcError as error:
            raise TransportError(
                "Base RPC is unavailable for route planning",
                context=Tx402ErrorContext(request_id=request_id, phase="route"),
                details={"causeCategory": error.failure},
                cause=error,
            ) from error
        if reading.balance_atomic < int(item.requirement["amountAtomic"]):
            raise InsufficientLiquidityError(
                "No offered route has sufficient balance",
                context=Tx402ErrorContext(request_id=request_id, phase="route"),
                details={
                    "deficits": [
                        {
                            "network": item.requirement["network"],
                            "requiredAtomic": item.requirement["amountAtomic"],
                            "availableAtomic": str(reading.balance_atomic),
                        }
                    ]
                },
            )
        signature, reservation_id, expires = await asyncio.to_thread(
            self._core.reserve_and_sign,
            request=request,
            captured_body=body,
            host=host,
            request_id=request_id,
            item=item,
            asset=asset,
            address=address,
            plan=plan,
            challenge_hash=payment_required["headerHash"],
        )
        retry = _retry_request(
            request, _fresh_body(request, body, request_id), signature, request_id
        )
        try:
            paid = await _with_deadline_async(
                self._inner.handle_async_request(retry),
                self._core.payment_retry_timeout_ms,
            )
        except TimeoutError as error:
            raise AmbiguousPaymentError(
                "Paid request timed out",
                context=Tx402ErrorContext(
                    request_id=request_id,
                    phase="retry",
                    paid="unknown",
                    reservation_id=reservation_id,
                ),
                details={
                    "reservationExpiresAtEpochMs": expires,
                    "causeCategory": "timeout",
                },
                cause=error,
            ) from error
        except httpx.HTTPError as error:
            raise AmbiguousPaymentError(
                "Paid request transport failed",
                context=Tx402ErrorContext(
                    request_id=request_id,
                    phase="retry",
                    paid="unknown",
                    reservation_id=reservation_id,
                ),
                details={
                    "reservationExpiresAtEpochMs": expires,
                    "causeCategory": "transport",
                },
                cause=error,
            ) from error
        return self._core.complete(
            paid,
            request_id=request_id,
            reservation_id=reservation_id,
            reservation_expires=expires,
        )

    async def aclose(self) -> None:
        await self._inner.aclose()


ClientT = TypeVar("ClientT", bound="Tx402Client")


class Tx402Client:
    """Synchronous HTTPX-compatible buyer client backed by :class:`Tx402Transport`."""

    def __init__(
        self,
        *,
        evm_signer: EvmSigner | None = None,
        policy: Policy | None = None,
        routing: RoutingPolicy | None = None,
        spend_store: MemorySpendStore | None = None,
        transport: httpx.BaseTransport | None = None,
        evm_rpc_transport: httpx.BaseTransport | None = None,
        manifest: Mapping[str, Any] = BUNDLED_MANIFEST,
        clock: Clock = _system_clock,
        allow_insecure_localhost: bool = False,
        payment_retry_timeout_ms: int = _PAYMENT_RETRY_TIMEOUT_MS,
    ) -> None:
        verified = assert_valid_release_manifest(
            manifest,
            context=Tx402ErrorContext(request_id="configuration", phase="initial"),
            now_epoch_ms=clock(),
        )
        if (
            isinstance(payment_retry_timeout_ms, bool)
            or not isinstance(payment_retry_timeout_ms, int)
            or payment_retry_timeout_ms < _MIN_PAYMENT_RETRY_TIMEOUT_MS
        ):
            raise _configuration("payment_retry_timeout_ms", "below-minimum")
        self._store = spend_store or MemorySpendStore()
        engine = PolicyEngine(verified, policy, routing)
        core = _Core(
            evm_signer=evm_signer,
            policy=engine,
            spend_store=self._store,
            manifest=verified,
            clock=clock,
            rpc_transport=evm_rpc_transport,
            allow_insecure_localhost=allow_insecure_localhost,
            payment_retry_timeout_ms=payment_retry_timeout_ms,
        )
        self._transport = Tx402Transport(transport or httpx.HTTPTransport(), core)
        self._client = httpx.Client(transport=self._transport, follow_redirects=False)

    def request(
        self,
        method: str,
        url: str,
        *,
        body_factory: BodyFactory | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        if body_factory is not None:
            if any(key in kwargs for key in ("content", "data", "files", "json")):
                raise TypeError("body_factory cannot be combined with another request body")
            kwargs["content"] = body_factory()
        request = self._client.build_request(method, url, **kwargs)
        if body_factory is not None:
            request.extensions[_BODY_FACTORY_EXTENSION] = body_factory
        return self._client.send(request)

    def inspect(self, method: str, url: str, **kwargs: Any) -> PaymentInspection:
        return self._transport.inspect(self._client.build_request(method, url, **kwargs))

    def get_budget_state(
        self, *, policy_scope: str, asset_id: str, now_epoch_ms: int | None = None
    ) -> BudgetState:
        return self._store.get_budget_state(
            policy_scope=policy_scope,
            asset_id=asset_id,
            now_epoch_ms=_system_clock() if now_epoch_ms is None else now_epoch_ms,
        )

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", url, **kwargs)

    def close(self) -> None:
        self._client.close()

    def __enter__(self: ClientT) -> ClientT:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


AsyncClientT = TypeVar("AsyncClientT", bound="AsyncTx402Client")


class AsyncTx402Client:
    """Asynchronous HTTPX-compatible buyer client."""

    def __init__(
        self,
        *,
        evm_signer: EvmSigner | None = None,
        policy: Policy | None = None,
        routing: RoutingPolicy | None = None,
        spend_store: MemorySpendStore | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        evm_rpc_transport: httpx.AsyncBaseTransport | None = None,
        manifest: Mapping[str, Any] = BUNDLED_MANIFEST,
        clock: Clock = _system_clock,
        allow_insecure_localhost: bool = False,
        payment_retry_timeout_ms: int = _PAYMENT_RETRY_TIMEOUT_MS,
    ) -> None:
        verified = assert_valid_release_manifest(
            manifest,
            context=Tx402ErrorContext(request_id="configuration", phase="initial"),
            now_epoch_ms=clock(),
        )
        if (
            isinstance(payment_retry_timeout_ms, bool)
            or not isinstance(payment_retry_timeout_ms, int)
            or payment_retry_timeout_ms < _MIN_PAYMENT_RETRY_TIMEOUT_MS
        ):
            raise _configuration("payment_retry_timeout_ms", "below-minimum")
        self._store = spend_store or MemorySpendStore()
        engine = PolicyEngine(verified, policy, routing)
        core = _Core(
            evm_signer=evm_signer,
            policy=engine,
            spend_store=self._store,
            manifest=verified,
            clock=clock,
            rpc_transport=evm_rpc_transport,
            allow_insecure_localhost=allow_insecure_localhost,
            payment_retry_timeout_ms=payment_retry_timeout_ms,
        )
        self._transport = AsyncTx402Transport(transport or httpx.AsyncHTTPTransport(), core)
        self._client = httpx.AsyncClient(transport=self._transport, follow_redirects=False)

    async def request(
        self,
        method: str,
        url: str,
        *,
        body_factory: BodyFactory | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        if body_factory is not None:
            if any(key in kwargs for key in ("content", "data", "files", "json")):
                raise TypeError("body_factory cannot be combined with another request body")
            kwargs["content"] = body_factory()
        request = self._client.build_request(method, url, **kwargs)
        if body_factory is not None:
            request.extensions[_BODY_FACTORY_EXTENSION] = body_factory
        return await self._client.send(request)

    async def inspect(self, method: str, url: str, **kwargs: Any) -> PaymentInspection:
        return await self._transport.inspect(
            self._client.build_request(method, url, **kwargs)
        )

    def get_budget_state(
        self, *, policy_scope: str, asset_id: str, now_epoch_ms: int | None = None
    ) -> BudgetState:
        return self._store.get_budget_state(
            policy_scope=policy_scope,
            asset_id=asset_id,
            now_epoch_ms=_system_clock() if now_epoch_ms is None else now_epoch_ms,
        )

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("POST", url, **kwargs)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self: AsyncClientT) -> AsyncClientT:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.aclose()
