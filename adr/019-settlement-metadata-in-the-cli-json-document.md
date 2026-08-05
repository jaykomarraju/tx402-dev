# ADR-019 — Settlement metadata reaches the CLI's `--json` document, raw

**Status:** Accepted · **concretizes `SPEC.md` §11; changes no MUST**

Closes PLAN.md open item **O74** (MAJOR), filed by the S18 fresh-eyes UX pass.

## Context

The quickstart tells a buyer that a payment "shows up on a block explorer" and to confirm it
via the explorer's token-transfer tab. The lifecycle guide and the error reference both tell
a buyer with an ambiguous or undelivered outcome to "reconcile with the merchant first". Exit
`9` — settlement succeeded, resource unusable — is precisely the outcome where money moved
and nothing came back.

None of that advice was followable. S18 established that the settlement transaction hash and
the buyer's own wallet address were reachable from **nowhere** in the CLI:

- Plain output carries the response body on stdout and, on failure, the error code and
  message on stderr. Neither names an address or a transaction.
- `--json` carried `schemaVersion`, `ok`, `exitCode`, `dryRun`, `inspection`, `route`,
  `status`, `body`, `timings`, `error`. The documented schema and the real object agreed:
  no settlement identifier, no payer.
- The test merchant's log does not report it either.

So the product instructed the operator to perform a reconciliation it gave them no key for.
Confirmed at S19 against a real Base Sepolia settlement: exit `0`, money moved on-chain, and
the emitted document named neither the transaction nor the payer.

This is an **exposure decision, not new plumbing**. The settlement identifier already arrives
in the `PAYMENT-RESPONSE` header, tx402 already decodes it, and acting on it is how `paid:
true` is derived in the first place (ADR-016). The only question was whether it reaches the
operator, and in what form.

## The tension

There are two existing, deliberate, and **opposite** treatments of this identifier already in
the codebase, and neither is wrong:

1. **SPEC §10's event stream hashes it.** `payment.completed` carries `settlementIdHash`, and
   `core/client.ts` computes `sha256:…` over the raw value before emitting. Events are the
   thing that flows to a log aggregator, and a settlement identifier there is a payment graph
   handed to whoever operates that aggregator. Hashing is correct for events.
2. **SPEC §5.3's ledger keeps it raw.** `SpendEntry.settlementId` is the unhashed value, and
   `core-spec/schemas/spend-entry.schema.json` types it as a 1–256 character string. The
   ledger is process-local (ADR-007) and belongs to the buyer. Raw is correct there.

The question is therefore which of these two the `--json` document resembles.

## Decision

**`--json` resembles the ledger, not the event stream, and carries the raw identifier.**

A new top-level `settlement` key is emitted:

```json
"settlement": {
  "status": "committed",
  "transaction": "0x8a01f2027e5af993977c5c4c7dded4e8a031aa0a07578aa2f5d429f670af5af0",
  "payer": "0xaad1566216D2447B530E04945dfEefD04C84967B"
}
```

The reasoning is that `--json` goes to **the buyer's own stdout**, which is the same trust
boundary as the buyer's own ledger, and not the aggregator boundary the hash exists to
protect. A hash would also be useless for the one job the value has here: you cannot look up
`sha256:…` on a block explorer. Neither existing treatment changes — the events still hash,
the ledger is still raw — and only this reader is new.

Three consequences follow, each chosen deliberately:

- **`status` reuses the SDK's own disposition vocabulary.** `committed` is the ledger's
  `paid: true`; `unknown` is its `paid: "unknown"`. The CLI reads the disposition from the
  error's own `context.paid` rather than inferring it from the exit code, so it cannot drift
  out of step with what the SDK actually concluded. Inventing a third vocabulary for the same
  three states is how two of them eventually disagree.
- **The key is always present, and `null` when nothing was signed.** An absent key cannot
  distinguish "no payment happened" from "this build does not report settlement". Presence is
  gated on the `budget.reserved` event, which is emitted immediately before the signer becomes
  reachable — so it is the precise test for "money is in play", and a merchant that answered
  `200` outright reports `null` rather than a fabricated settlement.
- **The entry is matched by reservation id, not by recency.** Taking the newest ledger entry
  is correct for the CLI's process-local store and wrong the moment a shared `SpendStore`
  (ADR-018) has another process writing to it. Matching on the id the run itself reserved is
  correct in both cases.

The same facts are also printed to **stderr** on exits `8` and `9`. Those are the two outcomes
whose documented remedy is "reconcile before retrying", and making the operator re-run a
_payment_ under `--json` to obtain the identifier would be the one action that advice exists
to prevent.

### `schemaVersion` stays at `1`

`schemaVersion` is documented as changing "only on a breaking shape change, so a script can
pin it". Adding a key breaks no reader: every field a `schemaVersion: 1` consumer already
parses is still present, unmoved, and unchanged in meaning. No JSON Schema governs this
document, so nothing rejects it under `additionalProperties: false`.

Bumping it was considered and rejected. A bump would let a script detect the new capability by
version, but it would do so by **falsifying the documented meaning of the field** — and every
existing script pinned to `1` would begin failing against a CLI whose shape it still fully
understands. Breaking every current consumer to add a detection channel for a key whose own
presence is the detection channel is the worse trade.

## Consequences

- The quickstart's "check the explorer" and the error reference's "reconcile with the
  merchant" are now instructions the operator can actually carry out.
- `payer` requires resolving the signer for the selected route's chain family. Where no signer
  matches — no route was ever planned — it is `null` rather than a guess.
- `transaction` is `null` when the reservation never committed (an ambiguous outcome) and also
  when the merchant supplied no identifier at all: the pinned protocol marks
  `PAYMENT-RESPONSE` optional and that case commits with a warning rather than failing
  (SPEC §6.7). `null` therefore means "tx402 has no identifier", never "there was no payment"
  — `status` carries that.
- Both languages emit byte-identical documents, verified at S19 against live Base Sepolia
  settlements.
