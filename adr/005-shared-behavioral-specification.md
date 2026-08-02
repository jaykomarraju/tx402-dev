# ADR-005 — Shared behavioral specification

**Status:** Accepted · transcribed from `SPEC.md` §2 (ADR-005)

## Context

Independent implementations of the same specification drift without shared test vectors.

## Decision

TypeScript is the **reference implementation** for wire fixtures and protocol vectors. Python
**MUST** pass the same language-neutral JSON conformance fixtures. Public behavior, error codes,
route ordering, and policy arithmetic must match exactly.

## Consequences

- `core-spec/conformance/` is versioned and consumed by both SDK test suites.
- Sequencing follows from this: TypeScript is built through the full state machine first, the
  fixtures are frozen, and Python is then implemented against the frozen fixtures
  (see `PLAN.md` §2 D5).
- T-016 (identical selected route, error code, and normalized output across both languages) is a
  release-blocking gate.
