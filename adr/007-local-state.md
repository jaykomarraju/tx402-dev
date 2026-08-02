# ADR-007 — Local state

**Status:** Accepted · transcribed from `SPEC.md` §2 (ADR-007)

## Context

The MVP is a library with no hosted state. Implicit filesystem writes are unsafe in serverless,
read-only, and multi-process container environments.

## Decision

The hourly budget ledger is **process-local** and is persisted only when the application supplies a
`SpendStore`. The default is an in-memory monotonic rolling-window store.

## Consequences

- Multi-process deployments **must** provide a shared store adapter; otherwise limits apply
  **per process**, not per deployment.
- This behavior is explicit in diagnostics — `getBudgetState()` reports the store kind so an
  operator can tell a per-process limit from a shared one.
- No implicit filesystem or network writes. See also SEC-010: no remote telemetry by default.
