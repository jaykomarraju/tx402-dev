# ADR-006 — Money representation

**Status:** Accepted · transcribed from `SPEC.md` §2 (ADR-006)

## Context

Floating-point arithmetic can silently bypass a spend cap or sign an incorrect value. A budget
guardrail that is off by one ULP is not a guardrail.

## Decision

All token amounts and budget values **MUST** be represented internally as **integer atomic units**.
Public money inputs are **decimal strings**. JavaScript `number` and Python `float` inputs are
**rejected**, not coerced.

## Consequences

- USDC uses the token metadata `decimals` from the signed release manifest, normally 6.
- All comparisons — per-request cap, hourly budget, balance sufficiency — are integer-only.
- The money parser is a P0 module with property-based tests and golden vectors shared across
  both languages.
- Rejection is a `ConfigurationError` at client construction where the value is static, and a typed
  policy error where the value arrives at runtime.
