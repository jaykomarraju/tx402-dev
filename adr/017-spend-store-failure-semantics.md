# ADR-017 — A spend-store failure after settlement is a typed, non-retryable, paid outcome

**Status:** Accepted · **fills a gap in `SPEC.md` §5.3 / §8; changes no MUST**

Closes PLAN.md open item **O46** (HIGH), filed by the S15 pre-publication audit.

## Context

SPEC §4.3 makes `spendStore` a supported extension point — "must support atomic
reserve/commit/release" — and SPEC §5.3 specifies what the ledger records. Neither says what
happens when the store itself fails, and a pluggable store is exactly the component most
likely to: it is the one a caller replaces with a network round trip to Redis or Postgres so
that a fleet of agent processes shares one hourly cap.

The audit injected a store whose `commit` rejects, after a local merchant and a local EVM
RPC had completed a real 50,000-unit payment and returned 200 with a successful
`PAYMENT-RESPONSE`. The resource and the settlement had both succeeded before the partial
write. What came back:

- **TypeScript:** `TX402_TRANSPORT`, `retryable: true`, `phase: "policy"`, no paid context.
- **Python:** a raw `RuntimeError`, which is not a tx402 error at all.
- **Both:** committed 0, reserved 50,000.

Each of those is wrong in its own way. `retryable: true` invites the one action that pays
twice. `phase: "policy"` points the operator at the wrong half of the request. The absent
paid context withholds the single most important fact — the money moved. And an untyped
`RuntimeError` breaks the promise SPEC §4.2 makes about every failure being typed, which is
the promise a `try/except Tx402Error` is written against.

A related defect sat in the cleanup path: Python's `release_quietly` suppressed only
`Tx402Error`, so an adapter raising an ordinary `KeyError` from _cleanup_ replaced whatever
precise pre-transmission error had caused the cleanup.

## Decision

**A store failure is classified by what had already happened when it occurred.**

### Before a signature exists — `reserve`

Any non-tx402 exception from `reserve` becomes `TransportError` with
`causeCategory: "spend-store-unavailable"` at `phase: "policy"`. `retryable` is **true**,
which is honest: SEC-002 guarantees no signer has been reached, so no money can have moved
and retrying is safe. `BudgetExceededError` and anything else already typed pass through
untouched — a refused budget is a decision, not an outage.

### After settlement — `commit`

Any exception from `commit` becomes `ResourceDeliveryError` with:

- `context.paid: **true**` — the merchant's own metadata reported a successful settlement,
  so tx402 knows the money moved and says so;
- `context.phase: "complete"`;
- `details.reason: "spend-store-commit-failed"`, exported as
  `SPEND_STORE_COMMIT_FAILED_REASON` in both languages so a caller branches on a constant
  rather than a message string;
- `details.storeKind` and `details.reservationExpiresAtEpochMs`;
- `retryable: **false**`, which follows from the taxonomy: `TX402_RESOURCE_DELIVERY` is
  `app-dependent`, and ADR-011's derivation makes only `caller-policy` retryable.

**The reservation is not released.** It expires on its own after 120 seconds, so the budget
is over-counted for at most a TTL — which is the conservative direction to be wrong in when
money has demonstrably moved.

### Cleanup never masks the failure it is cleaning up after

`release_quietly` suppresses `Exception`, not `Tx402Error`. `BaseException` is deliberately
**not** caught: cancellation and `KeyboardInterrupt` must still propagate. TypeScript's
equivalent already swallowed everything and is unchanged.

### `getBudgetState` may fail without failing the request

A snapshot is diagnostics. Both clients already swallowed a failure there and continue to.

## Rationale

**Why fail the call rather than return the resource.** The alternative is tempting: the
caller asked for a resource, the resource is right there, and only tx402's bookkeeping
broke. But the bookkeeping _is_ the product — SPEC §1 and SEC-002 make the local spend
guardrail the reason to use this SDK over `fetch`. Returning a resource while silently
having no record of what it cost means the next call in the same hour is evaluated against a
cap that has forgotten a payment, which is precisely the overspend the guardrail exists to
prevent. A caller who would rather have the resource can catch one typed error and go on;
a caller who would rather not overspend cannot recover a fact tx402 never told them.

**Why `paid: true` rather than `"unknown"`.** `"unknown"` is for outcomes tx402 genuinely
cannot determine — a transport failure after transmission, a corrupt settlement envelope.
This is not one of those. The merchant reported a successful settlement and tx402 read it;
the uncertainty is entirely about the local write. Reporting `"unknown"` would understate
what is known and would push the caller toward reconciliation they do not need.

**Why not a new error code.** The taxonomy is frozen at fifteen codes (ADR-011, SPEC §8) and
adding one is a minor release with a cross-language fixture change. `ResourceDeliveryError`
already means "the payment stands and you did not get what you paid for", which is exactly
this situation with the resource replaced by the ledger entry. `details.reason` carries the
distinction, which is what `reason` is for.

**Why `reserve` and `commit` classify differently.** Because the same exception means
different things at the two sites, and the difference is whether a signature exists. That is
the asymmetry SPEC §6.7 already draws for the merchant's answer; this ADR draws the same
line for the store.

## Consequences

- **`spendStore` adapters now have a specified error contract**, documented on the
  TypeScript `SpendStore` interface and the Python `SpendStore` protocol in the same words
  (ADR-018): raise `BudgetExceededError` for an over-cap reserve, raise anything for an
  outage, never fabricate a committed entry.
- **Two exported constants per language** — `SPEND_STORE_COMMIT_FAILED_REASON` and
  `SPEND_STORE_UNAVAILABLE_CAUSE`.
- **Failure-injection tests in both languages** cover a failing `commit`, a failing
  `reserve`, and a failing `release`, and assert the reservation state after each. All
  were confirmed to fail on the S15 commit.
- **No SPEC MUST changes.** This fills a gap SPEC left open rather than narrowing anything
  it requires.

## References

- `SPEC.md` §4.2 (typed errors), §4.3 (`spendStore`), §5.3, §6.7, §8, SEC-002
- ADR-011 (error taxonomy and the `retryable` derivation), ADR-016, ADR-018
- PLAN.md open item O46 (opened S15, decided S15b)
