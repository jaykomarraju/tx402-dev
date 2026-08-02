# ADR-004 — Protocol version boundary

**Status:** Accepted · transcribed from `SPEC.md` §2 (ADR-004)

## Context

The x402 protocol is actively evolving. Separating transport, envelope decoding, scheme signing, and
routing prevents a future v3 from forcing a client rewrite.

## Decision

v0.1 **MUST** implement x402 protocol v2 headers: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
`PAYMENT-RESPONSE`. Decoders and scheme handlers are plugins selected by **version, scheme, and
network**.

## Consequences

- Unknown versions fail with `UnsupportedProtocolError`; unknown schemes fail with
  `UnsupportedSchemeError`. Neither ever falls back to heuristic parsing.
- v1's `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers are **not** supported in v0.1. Upstream
  `@x402/core` retains v1 support; tx402 does not expose it.
- Verified against `@x402/core` 2.20.0: the v2 header names above are exactly what upstream emits
  and consumes.
