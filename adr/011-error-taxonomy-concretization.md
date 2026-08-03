# ADR-011 — Error taxonomy concretization

**Status:** Accepted · **concretizes `SPEC.md` §8 and §4.2**

## Context

`SPEC.md` §8 defines the error model as a table with three columns — `Code / class`,
`Retryable`, and `Meaning / required context` — plus a `Tx402ErrorContext` interface. §4.2
separately states that `Tx402Error` carries `code, message, retryable, context, cause`.

Freezing that as code at M0 surfaced two gaps. Neither changes a **MUST**; both are places
where the specification admits more than one implementation, and two implementations that
chose differently would fail conformance while each remaining defensible.

### Gap 1 — the `Retryable` column has six values, not two

The column reads, verbatim across the fifteen rows:

| Value                  | Rows                                                                                       |
| :--------------------- | :----------------------------------------------------------------------------------------- |
| `No`                   | Config, ReservedHeader, NonReplayable, Protocol, Scheme, Invalid, Budget, Domain, Redirect |
| `Conditional`          | InsufficientLiquidity, Signer                                                              |
| `Yes after correction` | ClockSkew                                                                                  |
| `No automatic retry`   | AmbiguousPayment                                                                           |
| `App-dependent`        | ResourceDelivery                                                                           |
| `Yes by caller policy` | Transport                                                                                  |

§4.2 nonetheless names a single field, `retryable`. A boolean cannot carry six values, and
collapsing them requires a rule the specification does not state. The dangerous collapse is
the permissive one: reporting `retryable: true` for `AmbiguousPaymentError` would invite
exactly the blind retry SPEC §6.7 warns against, and each such retry can pay twice.

### Gap 2 — where per-error data lives

`Tx402ErrorContext` is enumerated and closed: `requestId`, `phase`, `network`, `scheme`,
`amountAtomic`, `assetId`, `paid`, `reservationId`. The `Meaning / required context` column
asks individual errors for things that are not in it — `BudgetExceededError` must report
"Requested, cap, rolling committed/reserved"; `PaidRedirectBlockedError` must report "Source
and destination origins".

Widening `Tx402ErrorContext` to a union of everything would make it unenumerable, and SEC-003
requires snapshot tests that cover _every_ event and error field with seeded secrets. A test
cannot exhaustively cover an open-ended shape.

## Decision

### 1. Retryability is carried in full; `retryable` is derived

Every error carries `retryability`, a closed classification mapping one-to-one onto the SPEC
§8 column:

```ts
type Tx402Retryability =
  | "no" // No
  | "conditional" // Conditional
  | "after-correction" // Yes after correction
  | "no-automatic-retry" // No automatic retry
  | "app-dependent" // App-dependent
  | "caller-policy"; // Yes by caller policy
```

`retryable` remains, exactly as SPEC §4.2 requires, and is **derived** by a single rule:

```
retryable === (retryability === "caller-policy")
```

Read as: _safe to retry as-is, without the caller first changing something._ A transport
failure qualifies. Insufficient liquidity is retryable only after funding; clock skew only
after correction; an ambiguous payment only under an idempotency strategy the SDK cannot
supply. None of those are automatic, so all report `retryable: false`.

Both values are frozen in the `errors.taxonomy.frozen` conformance vector — the derivation
as well as the classification — so a change to the rule cannot pass on the grounds that the
classifications were left alone.

### 2. `context` stays closed; `details` carries per-error data

- **`context: Tx402ErrorContext`** — the SPEC §8 shape, unchanged and closed. Identical
  across all fifteen errors.
- **`details: Record<string, unknown>`** — the `Meaning / required context` column. The
  required keys are frozen per code in the taxonomy table and in the conformance vector.

Every `details` key must be redaction-safe: an identifier, an atomic amount, a count, or a
category label. Never a header value, a body, a signature, a key, or a signer's own message.

### 3. `cause` is retained but never serialized

`Tx402Error.cause` holds the underlying error for debugging. `toJSON()` / `to_dict()` emit
`name`, `code`, `message`, `retryable`, `retryability`, `context`, and `details` — and never
`cause` or the stack.

The underlying error routinely originates in a signer or an HTTP client and may carry a
payload, a URL with credentials, or a stack referencing either. SEC-003 makes emitting any of
that a redaction failure, so the boundary is drawn once in the base class rather than at every
log site, where it would eventually be forgotten.

### 4. Code-to-class binding is the cross-language contract

The fifteen codes and fifteen class names are identical in both SDKs. Callers switch on
`code`, not on class identity, because the code is what survives a serialization boundary.
`isTx402Error` / `is_tx402_error` accept a structurally valid error from another realm — a
worker thread, a subprocess, a second bundled copy of the package — since `instanceof` alone
fails in all three, and all three occur in the agent runtimes this SDK targets.

## Consequences

- No SPEC **MUST** is weakened. §4.2's `retryable` field exists with its stated name and
  boolean type; §8's context shape is implemented exactly as enumerated.
- `details` is additive public API. Adding a key to an error's `requiredDetails` is a minor
  release; removing or renaming one is a break, per SPEC §15.
- The `errors.taxonomy.frozen` vector makes any drift fail in three places simultaneously —
  the TypeScript table, the Python table, and the fixture.
- SEC-003's snapshot obligation is satisfiable, because `Tx402ErrorContext` stayed closed and
  `details` keys are enumerated per code.
