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

Status: the error taxonomy, release manifest, and canonical serialization landed at M0.
``Tx402Client`` and ``AsyncTx402Client`` land in session S9, built against the conformance
fixtures frozen by the TypeScript reference implementation (ADR-005).
"""

from __future__ import annotations

from tx402.bundled_manifest import BUNDLED_MANIFEST
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
from tx402.trusted_keys import MANIFEST_SIGNING_DOMAIN, TRUSTED_MANIFEST_KEYS

__all__ = [
    "BUNDLED_MANIFEST",
    "MANIFEST_SIGNING_DOMAIN",
    "PACKAGE_NAME",
    "PROJECT_URLS",
    "PROTOCOL_HEADERS",
    "REQUEST_ID_HEADER",
    "RESERVED_REQUEST_HEADERS",
    "TRUSTED_MANIFEST_KEYS",
    "TX402_ERROR_CODES",
    "TX402_ERROR_DESCRIPTORS",
    "TX402_ERROR_TAXONOMY",
    "X402_PROTOCOL_VERSION",
    "AmbiguousPaymentError",
    "BudgetExceededError",
    "ClockSkewError",
    "ConfigurationError",
    "DomainNotAllowedError",
    "InsufficientLiquidityError",
    "InvalidPaymentRequiredError",
    "NonReplayableRequestError",
    "PaidRedirectBlockedError",
    "ResourceDeliveryError",
    "SignerError",
    "TransportError",
    "Tx402Error",
    "Tx402ErrorContext",
    "Tx402ErrorDescriptor",
    "UnsupportedProtocolError",
    "UnsupportedSchemeError",
    "assert_valid_release_manifest",
    "is_tx402_error",
    "require_network",
    "resolve_network",
    "verify_release_manifest",
]
