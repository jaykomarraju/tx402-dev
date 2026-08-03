"""Stage B handlers — the Python SDK executed against the shared vectors.

One handler per vector ``kind``. Registering a handler is what claims the kind; the runner
fails if a vector at or below :data:`IMPLEMENTED_THROUGH` has none, so this module and that
constant move together.

Handlers raise on mismatch rather than returning ``False``, because the diff is the only
genuinely useful part of a conformance failure.
"""

from __future__ import annotations

import base64
import hashlib
from typing import Any, Final

import pytest

from tests.conformance.runner import register_handler
from tx402.canonical_json import CanonicalJsonError, canonicalize_json
from tx402.errors import TX402_ERROR_TAXONOMY, Tx402Error
from tx402.fingerprint import (
    digest_request_body,
    fingerprint_request,
    normalize_fingerprint_url,
)
from tx402.ledger import MemorySpendStore
from tx402.manifest import resolve_network, verify_release_manifest
from tx402.protocol import decode_payment_required

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


def _protocol_decode_payment_required(vector: dict[str, Any]) -> None:
    payload = vector["input"]
    expected = vector["expected"]
    header = payload.get("header")
    if "generatedHeader" in payload:
        header = base64.b64encode(
            b"x" * int(payload["generatedHeader"]["decodedBytes"])
        ).decode("ascii")
    arguments: dict[str, Any] = {
        "request_url": payload["requestUrl"],
        "request_method": payload["requestMethod"],
        "request_id": vector["id"],
        "clock_epoch_ms": payload["clockEpochMs"],
    }
    if expected["outcome"] == "invalid":
        with pytest.raises(Tx402Error) as raised:
            decode_payment_required(header, **arguments)
        assert raised.value.code == expected["errorCode"]
        assert raised.value.details.get("reason") == expected["reason"]
        return

    normalized = decode_payment_required(
        header,
        **arguments,
    )

    assert expected["outcome"] == "valid"
    assert normalized == expected["normalized"]


register_handler("protocol.decode-payment-required", _protocol_decode_payment_required)


def _request_fingerprint(vector: dict[str, Any]) -> None:
    payload = vector["input"]
    expected = vector["expected"]
    assert normalize_fingerprint_url(payload["url"]) == expected["normalizedUrl"]
    assert digest_request_body(payload["body"]) == expected["bodyHash"]
    assert (
        fingerprint_request(
            method=payload["method"],
            url=payload["url"],
            body=payload["body"],
            challenge_hash=payload["challengeHash"],
        )
        == expected["fingerprint"]
    )


def _spend_ledger_behavior(vector: dict[str, Any]) -> None:
    store = MemorySpendStore()
    outcomes: list[dict[str, Any]] = []
    for operation in vector["input"]["operations"]:
        action = operation["action"]
        try:
            if action == "reserve":
                reservation = store.reserve(
                    reservation_id=operation["reservationId"],
                    request_id=operation["requestId"],
                    policy_scope=operation["policyScope"],
                    request_fingerprint=operation["requestFingerprint"],
                    asset_id=operation["assetId"],
                    amount_atomic=operation["amountAtomic"],
                    max_per_hour_atomic=operation["maxPerHourAtomic"],
                    now_epoch_ms=operation["nowEpochMs"],
                )
                outcomes.append({"outcome": "reserved", "state": reservation.state})
            elif action == "commit":
                store.commit(
                    reservation_id=operation["reservationId"],
                    committed_at_epoch_ms=operation["committedAtEpochMs"],
                    settlement_id=operation.get("settlementId"),
                )
                outcomes.append({"outcome": "committed"})
            elif action == "release":
                reservation = store.release(
                    reservation_id=operation["reservationId"],
                    now_epoch_ms=operation["nowEpochMs"],
                )
                outcomes.append({"outcome": "released", "state": reservation.state})
            elif action == "snapshot":
                state = store.get_budget_state(
                    policy_scope=operation["policyScope"],
                    asset_id=operation["assetId"],
                    now_epoch_ms=operation["nowEpochMs"],
                )
                outcomes.append(
                    {
                        "outcome": "snapshot",
                        "committedAtomic": state.committed_atomic,
                        "reservedAtomic": state.reserved_atomic,
                        "reservationStates": [
                            reservation.state for reservation in state.reservations
                        ],
                        "entryCount": len(state.entries),
                    }
                )
            else:
                raise ValueError(f"Unknown ledger operation {action}")
        except Tx402Error as error:
            outcomes.append({"outcome": "error", "errorCode": error.code})
    assert outcomes == vector["expected"]["outcomes"]


register_handler("request.fingerprint", _request_fingerprint)
register_handler("spend-ledger.behavior", _spend_ledger_behavior)
