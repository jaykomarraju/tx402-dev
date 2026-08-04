"""tx402 — resilient x402 buyer SDK.

Wraps a normal HTTP client, interprets ``402 Payment Required`` challenges, enforces
local spend policy *before* any key is touched, deterministically selects a payment
route across the networks the merchant offered, signs an authorization, and retries.

Example::

    from tx402 import Policy, Tx402Client

    client = Tx402Client(
        evm_signer=evm_signer,
        solana_signer=solana_signer,
        policy=Policy(
            max_per_request="0.50 USDC",
            max_per_hour="10.00 USDC",
            allowed_networks=["eip155:8453", "solana:mainnet"],
        ),
    )

    response = client.post(url, json={"prompt": "Hello"})

Status: implemented through M3 against the frozen cross-language conformance fixtures.
"""

from __future__ import annotations

from tx402.bundled_manifest import BUNDLED_MANIFEST
from tx402.client import (
    AsyncTx402Client,
    AsyncTx402Transport,
    PaymentInspection,
    Tx402Client,
    Tx402Transport,
)
from tx402.errors import (
    TX402_ERROR_CODES,
    TX402_ERROR_DESCRIPTORS,
    TX402_ERROR_TAXONOMY,
    AmbiguousPaymentError,
    BudgetExceededError,
    ClockSkewError,
    ConfigurationError,
    DomainNotAllowedError,
    InsufficientLiquidityError,
    InvalidPaymentRequiredError,
    NonReplayableRequestError,
    PaidRedirectBlockedError,
    ReservedHeaderError,
    ResourceDeliveryError,
    SignerError,
    TransportError,
    Tx402Error,
    Tx402ErrorContext,
    Tx402ErrorDescriptor,
    UnsupportedProtocolError,
    UnsupportedSchemeError,
    is_tx402_error,
)
from tx402.evm import (
    EvmRpcError,
    EvmRpcPool,
    EvmSigner,
    EvmSignerPresentation,
    EvmTypedDataRequest,
    ExactEvmPlan,
    create_evm_authorization,
    encode_balance_of_call_data,
    plan_exact_evm_authorization,
    resolve_evm_address,
)
from tx402.ledger import (
    RESERVATION_TTL_MS,
    ROLLING_WINDOW_MS,
    BudgetState,
    MemorySpendStore,
    SpendEntry,
    SpendReservation,
)
from tx402.manifest import (
    assert_valid_release_manifest,
    require_network,
    resolve_network,
    verify_release_manifest,
)
from tx402.meta import (
    PACKAGE_NAME,
    PROJECT_URLS,
    PROTOCOL_HEADERS,
    REQUEST_ID_HEADER,
    RESERVED_REQUEST_HEADERS,
    X402_PROTOCOL_VERSION,
)
from tx402.money import (
    MoneyAssetMetadata,
    MoneyParseError,
    format_money_decimal,
    parse_money_atomic,
    parse_positive_money_atomic,
)
from tx402.policy import (
    Policy,
    PolicyDecision,
    PolicyEngine,
    PolicyRequirement,
    RoutingPolicy,
)
from tx402.trusted_keys import MANIFEST_SIGNING_DOMAIN, TRUSTED_MANIFEST_KEYS

__all__ = [
    "BUNDLED_MANIFEST",
    "MANIFEST_SIGNING_DOMAIN",
    "PACKAGE_NAME",
    "PROJECT_URLS",
    "PROTOCOL_HEADERS",
    "REQUEST_ID_HEADER",
    "RESERVATION_TTL_MS",
    "RESERVED_REQUEST_HEADERS",
    "ROLLING_WINDOW_MS",
    "TRUSTED_MANIFEST_KEYS",
    "TX402_ERROR_CODES",
    "TX402_ERROR_DESCRIPTORS",
    "TX402_ERROR_TAXONOMY",
    "X402_PROTOCOL_VERSION",
    "AmbiguousPaymentError",
    "AsyncTx402Client",
    "AsyncTx402Transport",
    "BudgetExceededError",
    "BudgetState",
    "ClockSkewError",
    "ConfigurationError",
    "DomainNotAllowedError",
    "EvmRpcError",
    "EvmRpcPool",
    "EvmSigner",
    "EvmSignerPresentation",
    "EvmTypedDataRequest",
    "ExactEvmPlan",
    "InsufficientLiquidityError",
    "InvalidPaymentRequiredError",
    "MemorySpendStore",
    "MoneyAssetMetadata",
    "MoneyParseError",
    "NonReplayableRequestError",
    "PaidRedirectBlockedError",
    "PaymentInspection",
    "Policy",
    "PolicyDecision",
    "PolicyEngine",
    "PolicyRequirement",
    "ReservedHeaderError",
    "ResourceDeliveryError",
    "RoutingPolicy",
    "SignerError",
    "SpendEntry",
    "SpendReservation",
    "TransportError",
    "Tx402Client",
    "Tx402Error",
    "Tx402ErrorContext",
    "Tx402ErrorDescriptor",
    "Tx402Transport",
    "UnsupportedProtocolError",
    "UnsupportedSchemeError",
    "assert_valid_release_manifest",
    "create_evm_authorization",
    "encode_balance_of_call_data",
    "format_money_decimal",
    "is_tx402_error",
    "parse_money_atomic",
    "parse_positive_money_atomic",
    "plan_exact_evm_authorization",
    "require_network",
    "resolve_evm_address",
    "resolve_network",
    "verify_release_manifest",
]
