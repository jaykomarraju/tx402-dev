"""Stage B handlers — the Python SDK executed against the shared vectors.

One handler per vector ``kind``. Registering a handler is what claims the kind; the runner
fails if a vector at or below :data:`IMPLEMENTED_THROUGH` has none, so this module and that
constant move together.

Handlers raise on mismatch rather than returning ``False``, because the diff is the only
genuinely useful part of a conformance failure.
"""

from __future__ import annotations

import hashlib
from typing import Any, Final

import pytest

from tests.conformance.runner import register_handler
from tx402.canonical_json import CanonicalJsonError, canonicalize_json
from tx402.errors import TX402_ERROR_TAXONOMY
from tx402.manifest import resolve_network, verify_release_manifest

#: Manifest failures all surface to callers as ConfigurationError (SPEC §5.4).
MANIFEST_ERROR_CODE: Final = "TX402_CONFIG_INVALID"


def _errors_taxonomy(vector: dict[str, Any]) -> None:
    expected = vector["expected"]["entries"]

    # Compared as whole lists, in order: the taxonomy's ordering is part of what is frozen,
    # and an entry-by-entry loop would let a reordering pass.
    actual = [
        {
            "code": entry.code,
            "className": entry.class_name,
            "retryability": entry.retryability,
            "retryable": entry.retryable,
            "requiredDetails": list(entry.required_details),
        }
        for entry in TX402_ERROR_TAXONOMY
    ]

    assert actual == expected


def _canonical_json(vector: dict[str, Any]) -> None:
    document = vector["input"]["document"]
    expected = vector["expected"]

    if "error" in expected:
        with pytest.raises(CanonicalJsonError) as raised:
            canonicalize_json(document)
        # The reason, not merely the failure: two implementations that reject the same
        # input for different reasons have not agreed on anything useful.
        assert raised.value.reason == expected["error"]
        return

    canonical = canonicalize_json(document)
    assert canonical == expected["canonical"]

    digest = f"sha256:{hashlib.sha256(canonical.encode('ascii')).hexdigest()}"
    assert digest == expected["sha256"]


def _manifest_verify(vector: dict[str, Any]) -> None:
    payload = vector["input"]
    expected = vector["expected"]

    result = verify_release_manifest(
        payload["manifest"],
        now_epoch_ms=payload["nowEpochMs"],
        trusted_keys=payload.get("trustedKeys"),
    )

    if expected["outcome"] == "valid":
        assert result.valid, (
            f"Expected the manifest to verify, but it failed: "
            f"{result.reason} — {result.message}"
        )
        return

    assert not result.valid, (
        f"Expected the manifest to be rejected with {expected['reason']}, but it verified"
    )
    assert result.reason == expected["reason"]
    assert expected["errorCode"] == MANIFEST_ERROR_CODE


def _manifest_network_resolution(vector: dict[str, Any]) -> None:
    payload = vector["input"]
    expected = vector["expected"]

    result = resolve_network(payload["manifest"], payload["query"])

    if "resolved" in expected:
        assert result.resolved is not None, (
            f"Expected {payload['query']} to resolve to {expected['resolved']}, "
            f"but it failed: {result.message}"
        )
        assert result.resolved == expected["resolved"]
        assert result.was_alias == expected["wasAlias"]
        return

    assert result.resolved is None, (
        f"Expected {payload['query']} to be rejected, but it resolved to {result.resolved}"
    )
    assert result.reason == expected["reason"]
    assert expected["errorCode"] == MANIFEST_ERROR_CODE


register_handler("errors.taxonomy", _errors_taxonomy)
register_handler("canonical-json", _canonical_json)
register_handler("manifest.verify", _manifest_verify)
register_handler("manifest.network-resolution", _manifest_network_resolution)

# `protocol.decode-payment-required` has no handler yet — the decoder lands in session S9
# for Python, against the fixtures the TypeScript reference implementation freezes at M6.
# Its vectors are Stage A only until IMPLEMENTED_THROUGH is raised, at which point the
# runner will refuse to pass without one.
