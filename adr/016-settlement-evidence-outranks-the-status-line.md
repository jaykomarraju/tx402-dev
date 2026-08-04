# ADR-016 — Settlement evidence outranks the status line, and a malformed PAYMENT-RESPONSE is not an absent one

**Status:** Accepted · **implements `SPEC.md` §5.3 and narrows §6.7 for v0.1**

Closes PLAN.md open items **O44** (HIGH) and **O53** (MEDIUM), both filed by the S15
pre-publication audit.

## Context

Two findings, one module. Both live in `classifyPaidAttempt` / `classify_paid_attempt`, the
pure SPEC §6.7 disposition table both SDKs share, and both were preserved by tests that
asserted the implementation's behaviour rather than the specification's.

### O44 — a settled payment was reported unpaid

SPEC §5.3 ends with a sentence that is not conditional on anything:

> If payment settlement is reported successful but resource response is unusable, the spend
> remains committed and the SDK raises `ResourceDeliveryError` with `paid=true`.

Both clients read `PAYMENT-RESPONSE` **only for a 2xx**, and both disposition tables branch
on 402 / 5xx / 3xx / other-non-2xx _before_ settlement is consulted. So a merchant that
settled the payment and then failed to hand over the resource — a 403 from an authorization
layer sitting behind the payment layer, a 500 from the thing that generates the resource —
produced `failed`, reservation `released`, reason `paid-request-rejected`.

The consequences compound in the wrong direction. The caller is told `paid: false` about a
payment that happened. The hourly cap is handed back budget for money that left the wallet.
An autonomous caller acting on `paid: false` pays again. And the 402 case is worse still: a
merchant that re-challenges _while reporting a settlement_ would, under the old table, have
released and re-signed, which is a second payment for one resource.

The audit reproduced it by calling the exported classifier directly with attempt 1 of 2,
status 403, settlement `success`. The Python integration fixture `Merchant(paid_status=403)`
sent a **successful** settlement header by default and the test nevertheless asserted
release — the green suite encoded the defect.

### O53 — a corrupt settlement envelope was accepted as delivery

SPEC §6.7:

> A 2xx response is considered paid-success **only when any required upstream
> PAYMENT-RESPONSE parses successfully**. Missing response metadata is accepted only if the
> upstream pinned protocol marks it optional; a diagnostic warning is emitted.

The two halves of that sentence describe two different facts, and the implementation had one
value for both. `SettlementEvidence` was `"success" | "unsuccessful" | "unknown"`, and
`"unknown"` meant _either_ "the merchant sent no header" _or_ "the merchant sent a header I
could not decode". A 2xx with `"unknown"` commits and returns the resource, so a corrupt
envelope was indistinguishable from an intentionally absent optional one except in the log
stream. A test asserted directly that `not-base64` succeeds.

## Decision

### 1. Settlement evidence is read on every status, and outranks the status line

`PAYMENT-RESPONSE` is decoded whatever the merchant's status line says. A reported
successful settlement produces a new disposition, `paid-undelivered`: reservation
**committed**, error `ResourceDeliveryError`, `context.paid: true`, `details.reason:
"settlement-succeeded-resource-unusable"`. It is checked **before every status branch**, so
no status can reach a branch that releases.

This includes 402. A merchant that re-challenges while reporting a settlement has
contradicted itself, and of the two readings only one is safe: believe the settlement, keep
the money accounted, do not sign again.

A non-2xx that claims _no_ settlement is unchanged — it still releases. That is the other
half of the rule, and it is what stops the fix degenerating into "always commit".

### 2. `absent` and `malformed` are separate evidence values

`SettlementEvidence` becomes `"success" | "unsuccessful" | "absent" | "malformed"`.

- **`absent`** — no header. Accepted on a 2xx, because the pinned upstream protocol marks
  the header optional, exactly as SPEC §6.7 permits. A warning is emitted.
- **`malformed`** — a header is present and does not decode. A protocol violation, and
  evidence in **no** direction. It cannot commit, because SPEC §6.7 makes parsing a
  precondition of paid-success. It must not release either, because a merchant that plainly
  attempted to report a settlement has not told us there was none. Retention is the only
  disposition left: `ambiguous`, reservation **retained**, `causeCategory:
"settlement-metadata-unparseable"`.

Malformed is checked on **every** status, immediately after the settlement-success rule. A
403 with a corrupt settlement header is not reliable evidence of non-settlement, and
releasing on it would be the O44 mistake in a different coat.

### 3. `kind` and `errorCode` are separate fields on a disposition

The money disposition and the public error identity are no longer the same decision. This is
what let O52 be fixed — a cross-origin redirect keeps `kind: "ambiguous"` and
`reservation: "retained"` while reporting `TX402_REDIRECT_BLOCKED`, which is the error SPEC
§6.1 names — without touching what happens to the money.

## Rationale

**Why commit rather than retain, when settlement succeeded.** Retaining would be the timid
choice and it would be wrong: a retained reservation expires after 120 seconds, so the money
would silently stop counting against the hourly cap while having actually left the wallet. A
commit is the only state that survives the TTL, and the merchant's own metadata is the
strongest evidence available that it should.

**Why fail the call rather than return the resource, when the envelope is corrupt.** The
resource arrived and is usable; only the settlement report is unreadable. Returning it would
be more convenient and would mean tx402 committed a spend it cannot reconcile against any
transaction it can name. ADR-014 already took this trade once, for the same reason: between
an unnecessary failure and an unverifiable success, v0.1 takes the failure. The caller is
told exactly what happened and the reservation is held, so nothing is lost that a check
against the merchant's own ledger cannot recover.

**Why not treat a malformed envelope as `unsuccessful`.** Because it is not. `unsuccessful`
means the merchant said it did not settle, which releases; a corrupt header says nothing at
all, and releasing on it would return budget for money that may well have moved.

## Consequences

- **Both disposition tables change**, in both languages, together.
- **Two frozen vectors change and two are added.** `absent-settlement-evidence-commits`
  loses its claim about undecodable headers; `ambiguous-after-transmission` gains the
  redirect error code from O52; every `"unknown"` becomes `"absent"`. New:
  `settlement-outranks-the-status-line` (four unusable statuses, all committing, including 402) and `malformed-settlement-metadata-is-never-evidence` (three statuses, all retained).
  The suite goes from 65 to 67. Changing a frozen vector needs an ADR, which is this one.
- **`conformance-vector.schema.json` widens**: the settlement enum gains two values, the
  disposition enum gains `paid-undelivered`, and the attempt/disposition arrays go from 3 to
  8 entries so a vector can put several independent cases side by side.
- **Tests that encoded the defect are replaced, not deleted.** The Python fixture's 403 case
  now sends no settlement header and still asserts release; the settled counterpart is a new
  test. `packages/tx402/test/audit-regressions.test.ts` and
  `packages/tx402-python/tests/test_audit_regressions.py` derive every case from the SPEC
  text above and were confirmed to fail on the S15 commit before the fix landed.
- **A caller can now receive `ResourceDeliveryError` with `paid: true` from a non-2xx.**
  That is the point, and it is `app-dependent`/`retryable: false`, so nothing retries it
  automatically.

## References

- `SPEC.md` §5.3 (spend ledger), §6.7 (completion), §8 (error taxonomy)
- `packages/tx402/src/core/completion.ts`, `packages/tx402-python/src/tx402/completion.py`
- `core-spec/conformance/vectors/completion/`
- ADR-014 (redirects are not followed), ADR-017 (store failure after settlement)
- PLAN.md open items O44, O53 (opened S15, decided S15b)
