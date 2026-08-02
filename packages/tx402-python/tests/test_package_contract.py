"""Guards package identity and the protocol boundary.

Mirrors ``packages/tx402/test/package-contract.test.ts``. Per ADR-005 the two SDKs must
agree on every public constant; these assertions are the cheapest possible tripwire for
drift, and they are expensive to get wrong after publish.
"""

from __future__ import annotations

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

    def test_core_install_pulls_only_codec_and_transport(self) -> None:
        deps = PYPROJECT["project"]["dependencies"]
        names = sorted(d.split(">")[0].split("[")[0].strip() for d in deps)
        assert names == ["httpx", "x402"]

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
