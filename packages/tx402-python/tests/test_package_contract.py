"""Guards package identity and the protocol boundary.

Mirrors ``packages/tx402/test/package-contract.test.ts``. Per ADR-005 the two SDKs must
agree on every public constant; these assertions are the cheapest possible tripwire for
drift, and they are expensive to get wrong after publish.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised only on the 3.10 CI leg
    import tomli as tomllib

from tx402 import (
    PACKAGE_NAME,
    PROTOCOL_HEADERS,
    RESERVED_REQUEST_HEADERS,
    X402_PROTOCOL_VERSION,
)

PYPROJECT: dict[str, Any] = tomllib.loads(
    (Path(__file__).parent.parent / "pyproject.toml").read_text()
)


class TestPackageContract:
    def test_publishes_under_the_unscoped_name_tx402(self) -> None:
        """ADR-009: identical unscoped name on npm and PyPI."""
        assert PYPROJECT["project"]["name"] == "tx402"
        assert PYPROJECT["project"]["name"] == PACKAGE_NAME

    def test_exposes_the_tx402_console_script(self) -> None:
        assert "tx402" in PYPROJECT["project"]["scripts"]

    def test_keeps_chain_support_behind_extras(self) -> None:
        """Mirrors the TypeScript subpath-export split (ADR-009)."""
        extras = PYPROJECT["project"]["optional-dependencies"]
        assert set(extras) >= {"evm", "svm", "all"}

    def test_core_install_pulls_only_codec_transport_and_ed25519(self) -> None:
        """The core install is a closed set, and each member has to justify itself.

        ``x402`` is the protocol codec and ``httpx`` the transport. ``cryptography`` is
        there because SPEC §5.4 makes offline manifest signature verification a
        precondition of client construction, SPEC §3.2 forbids implementing Ed25519 from
        scratch, and CPython has none in its standard library — TypeScript gets the same
        capability from ``node:crypto`` for free (ADR-012).

        Chain support is deliberately absent: it lives behind the ``evm``/``svm`` extras.
        """
        deps = PYPROJECT["project"]["dependencies"]
        names = sorted(d.split(">")[0].split("[")[0].strip() for d in deps)
        assert names == ["cryptography", "httpx", "x402"]

    def test_supports_python_3_10_through_3_13(self) -> None:
        assert PYPROJECT["project"]["requires-python"] == ">=3.10"


class TestProtocolConstants:
    def test_targets_x402_protocol_v2_only(self) -> None:
        """ADR-004."""
        assert X402_PROTOCOL_VERSION == 2

    def test_uses_v2_header_names_not_the_v1_x_payment_forms(self) -> None:
        """ADR-004."""
        assert PROTOCOL_HEADERS == {
            "payment_required": "PAYMENT-REQUIRED",
            "payment_signature": "PAYMENT-SIGNATURE",
            "payment_response": "PAYMENT-RESPONSE",
        }
        for header in PROTOCOL_HEADERS.values():
            assert not header.startswith("X-")

    def test_reserves_every_protocol_header_against_caller_override(self) -> None:
        """SPEC §6.1."""
        assert set(RESERVED_REQUEST_HEADERS) >= set(PROTOCOL_HEADERS.values())


class TestCrossLanguageParity:
    """ADR-005: the TypeScript constants are the reference; Python must match."""

    def test_protocol_constants_match_the_typescript_reference(self) -> None:
        ts_meta = (
            Path(__file__).parents[3] / "packages" / "tx402" / "src" / "meta.ts"
        ).read_text()

        assert f'export const PACKAGE_NAME = "{PACKAGE_NAME}"' in ts_meta
        assert f"export const X402_PROTOCOL_VERSION = {X402_PROTOCOL_VERSION}" in ts_meta
        for header in PROTOCOL_HEADERS.values():
            assert f'"{header}"' in ts_meta


class TestExtrasBoundary:
    """The core install must not pull a chain library (ADR-009).

    ``tx402.solana`` imports ``solders`` at module scope, so a re-export from
    ``tx402/__init__.py`` would silently make every core install depend on it — and the
    failure would surface as an ImportError on ``import tx402`` for a user who installed
    exactly what the README told them to.
    """

    def test_importing_tx402_loads_no_chain_library(self) -> None:
        probe = (
            "import sys, tx402; "
            "print(sorted(m for m in ('solders', 'solana', 'web3', 'eth_account') "
            "if m in sys.modules))"
        )
        result = subprocess.run(
            [sys.executable, "-c", probe], capture_output=True, text=True, check=True
        )
        assert result.stdout.strip() == "[]"

    def test_the_svm_extra_declares_the_spl_primitives_it_uses_directly(self) -> None:
        """ADR-013: tx402 builds the transaction, so solders is first-party here."""
        svm = PYPROJECT["project"]["optional-dependencies"]["svm"]
        assert any(item.startswith("solders") for item in svm)
