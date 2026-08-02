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

Status: scaffold. ``Tx402Client`` and ``AsyncTx402Client`` land in session S9, built
against the conformance fixtures frozen by the TypeScript reference implementation
(ADR-005).
"""

from __future__ import annotations

from tx402.meta import (
    PACKAGE_NAME,
    PROJECT_URLS,
    PROTOCOL_HEADERS,
    REQUEST_ID_HEADER,
    RESERVED_REQUEST_HEADERS,
    X402_PROTOCOL_VERSION,
)

__all__ = [
    "PACKAGE_NAME",
    "PROJECT_URLS",
    "PROTOCOL_HEADERS",
    "REQUEST_ID_HEADER",
    "RESERVED_REQUEST_HEADERS",
    "X402_PROTOCOL_VERSION",
]
