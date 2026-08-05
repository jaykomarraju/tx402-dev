# ADR-022 — A post-transmission failure is never classified as a pre-signature one

**Status:** Accepted · **changes one exit-code mapping and one log level; changes no MUST**

Closes PLAN.md open items **O96** (HIGH) and **O97** (MEDIUM), filed by the S28 fresh-eyes UX
pass.

## Context

The exit codes divide into two bands, and the division is the whole point of having nine of
them. Exits `2`–`7` mean no signature was ever produced; exits `8` and `9` mean one was. The CLI
guide states it as a property of `context.paid`: **absent** means "no signature was ever
produced", and it is documented as appearing on "exits `2`–`7`, and dry runs".

One reachable outcome broke that, and it is reachable from a scenario this repository ships.

Under `--scenario rechallenge-malformed` the merchant accepts the signature, then answers the
paid retry with a `402` whose `PAYMENT-REQUIRED` does not decode. Before this decision:

    rechallenge-malformed     → TX402_PAYMENT_REQUIRED_INVALID | context.paid = undefined  (exit 5)
    corrupt-payment-response  → TX402_PAYMENT_AMBIGUOUS        | context.paid = "unknown"  (exit 8)

The two are the same situation — the merchant sending an undecodable header of one kind or the
other, after the same transmitted signature — and they were classified in opposite bands. The
first landed on exit `5`, whose documented advice is "this client and this merchant cannot agree
on the challenge. Nothing local helps", which tells an operator with money potentially in play
not to reconcile.

The cause was mechanical. `decodePaymentRequired` is called on the re-challenge outside any
`try`, so its `PaymentRequiredInvalidError` escaped exactly as it would have from the _first_
challenge — where the classification is correct, because nothing has been signed yet.

Separately, the same pass found `request.failed` emitted **twice** on every ambiguous path in
TypeScript — once at `warn` from the ambiguity helper and once at `error` from the catch-all —
with the same `requestId` and an identical payload, while Python emitted it once and always at
`error`. Neither matched the documented rule, and the two did not match each other.

## Decision

### 1. An undecodable re-challenge is exit `9` with `paid: false`

`ResourceDeliveryError`, `reason: "rechallenge-undecodable"`, `phase: "complete"`.

**The release is kept.** An HTTP `402` is intelligible whatever its header says, and it is the
merchant declining the payment, so it remains evidence that no settlement occurred. This is not
a case where tx402 cannot tell what happened — it is a case where the merchant said "not paid"
in a malformed way. Settlement evidence still outranks the status line and is still read first:
a merchant that settles _and_ reports it in a valid `PAYMENT-RESPONSE` is caught as `paid: true`
with exit `9` before this branch is reached, which was verified directly.

**Exit `9` rather than exit `8`** because `paid` is known to be `false`, not unknown. Exit 9
already carries exactly this meaning for `max-paid-attempts-exhausted`: a signature was
transmitted, nothing was delivered, and no money moved. Exit 8 is for outcomes that cannot be
determined, and retaining the reservation for one that can would exhaust a caller's hourly cap
on a merchant that has plainly refused.

**The decode diagnostic is carried through**, as `decodeReason` and `schemaPath` on the new
error. The reason a reader was sent to exit `5` was real — the merchant's header is malformed
and they need to know how — and re-banding the outcome must not cost them that.

**A malformed _first_ challenge is untouched.** Before any signature exists, an undecodable
challenge is precisely what exit `5` is for, and it keeps its absent `paid`. The fix is scoped
to the post-transmission path, and a regression pins both halves.

### 2. `request.failed` is emitted once, at a level derived from `paid`

`warn` when `paid` is `"unknown"` — the money is still reserved and the outcome undetermined —
and `error` otherwise. One emission point per language, at the single catch-all that can see the
final disposition, so a raise site cannot add a second.

The previously documented rule is unchanged in wording. It was simply never implemented: it had
been written by reading the two `emit` call sites and inferring they were alternatives, rather
than by running them.

## Consequences

- **One exit-code mapping changes.** `TX402_PAYMENT_REQUIRED_INVALID` still maps to exit `5`;
  what changes is that this particular condition no longer raises that error. Any caller
  branching on exit `5` for a _post-signature_ re-challenge was branching on a bug.
- `context.paid` absent now means what the CLI guide has always said it means, on every
  reachable path.
- Operators counting `request.failed` count requests, and an alert on `error` no longer fires
  for outcomes the documentation calls `warn`. Both languages agree, which they did not before.
- `details.reason` gains one value, `rechallenge-undecodable`, alongside
  `settlement-unsuccessful` and `max-paid-attempts-exhausted`.
- The lifecycle guide now states the once-per-request guarantee explicitly, because the absence
  of that sentence is what allowed a double emission to look acceptable.

## What this does not change

The disposition table, the release/retain rules, the order of policy evaluation, and the
precedence of settlement evidence over the status line are all untouched. This decision is about
how one already-decided outcome is _reported_, not about what tx402 does with money.
