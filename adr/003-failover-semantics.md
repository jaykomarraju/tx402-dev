# ADR-003 — Failover semantics

**Status:** Accepted · transcribed from `SPEC.md` §2 (ADR-003)

## Context

A hedged direct-settlement race risks duplicate broadcasts and ambiguous resource fulfillment.
Route selection can still be fast without violating the protocol, by scoring known health _before_
signing rather than racing requests after signing.

## Decision

Failover occurs:

- across **merchant-offered payment requirements** and signer/RPC paths, **before** signing; and
- across **resource retries** only when a fresh payment authorization can be safely created.

The SDK **MUST NOT** submit one authorization concurrently to multiple merchants, and **MUST NOT**
directly race facilitator settle calls.

## Consequences

- At most one `PAYMENT-SIGNATURE` is attached to one resource retry attempt.
- A new attempt requires a brand-new authorization with a fresh nonce, plus idempotency safeguards.
- The `<150 ms` failover objective is a **decision-overhead** metric (parse → policy → route →
  reserve), not a guarantee about merchant, chain, or facilitator round-trip time.
