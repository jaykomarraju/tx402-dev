# ADR-020 — `inspect()` is the keyless question; `plan()` is not

**Status:** Accepted · **clarifies `SPEC.md` §11; changes no MUST**

Closes PLAN.md open item **O78** (HIGH), filed by the S20 fresh-eyes UX pass.

## Context

Two shipped examples — `examples/typescript/dry-run.ts` and `examples/python/dry_run.py` —
failed on every run, in every environment, with
`TX402_SCHEME_UNSUPPORTED: No offered network has a configured signer and chain adapter`.
Exporting keys did not help, because the examples deliberately configure no signers.

The failure is not a bug in the SDK. It is a contradiction between what four documents say:

- **`examples/README.md`**: "The dry-run examples need no key at all — that is the point of
  them", and its environment table marks `TX402_DEV_PRIVATE_KEY` required only for "the two
  quickstarts".
- **Each example's own header**: "Inspect a merchant's terms without paying, and without a
  key", with an inline comment predicting that route planning "will report every offered
  requirement as a candidate with `no-signer-configured`, which is exactly what you want to
  see".
- **The CLI guide and the quickstart**: "A dry run needs a configured key, even though it
  never signs with it… planning means reading your address and your balance on each offered
  chain in order to rank them — a route it cannot price is a route it cannot rank."
- **The shipped behaviour**: matches the CLI guide. `plan()` raises when no offered route has
  a signer.

So the examples asserted a capability that has never existed, and the CLI documentation
described the real one correctly. Two of the four shipped examples were guaranteed-fail code
contradicting their own README in three places.

## The tension

`no-signer-configured` is a real `RouteCandidate` rejection reason, and `PaymentPlan.candidates`
is documented as "Every requirement considered, ranked. Non-viable candidates are retained."
That is genuine evidence for the examples' reading: the planner _does_ model the keyless case,
and retains those candidates whenever at least one other route is viable. It is only when
**zero** routes are viable that route selection raises instead of returning.

So the honest question was: should `plan()` return a plan whose candidates are all non-viable,
rather than raising?

## Decision

**No. `plan()` keeps raising, and the examples are corrected to use `inspect()`.**

The two methods answer different questions, and only one of them is answerable without a key:

- **`inspect()`** answers _"what is this merchant asking for?"_ It performs the request,
  decodes and strictly validates `PAYMENT-REQUIRED`, and stops. It configures no signer,
  contacts no chain, and cannot spend anything. This is exactly the capability the examples
  promised, and it already existed.
- **`plan()`** answers _"what would I actually pay, and by which route?"_ Ranking requires
  reading an address and a balance on each offered chain. It is the same call that backs the
  CLI's `--dry-run`, and it is why that flag requires a key while still never producing a
  signature.

Three reasons this direction rather than the other:

1. **The raise is load-bearing where it fires.** Route selection is shared by `fetch()` and
   `plan()`. "No offered network has a configured signer and chain adapter" is documented in
   the quickstart's exit-5 table as one of the four causes of exit `5`, and the CLI's
   `--dry-run` depends on it. Making `plan()` return instead would either change that
   documented exit code or require the CLI to re-derive viability itself — a second
   implementation of the decision, on a money path, to fix a documentation defect.
2. **A keyless `plan()` would be lying by construction.** With no signer there is no address,
   so there is no balance, so every candidate's health and rank would be computed from
   nothing. A ranked list that cannot be ranked is worse than an error.
3. **The capability the examples wanted is real and already shipped.** Nothing had to be
   built; the examples were calling the wrong method.

`PaymentPlan.candidates` keeps its "non-viable candidates are retained" contract unchanged —
it describes the partial case, which is the case it was written for, and which still works:
plan a two-chain challenge with one chain configured and the unconfigured one comes back
retained and rejected.

## Consequences

- Both dry-run examples now run in any environment with no key set, verified at S21 on a live
  merchant in both languages.
- `examples/README.md` needed no change: its claims became true rather than being softened.
- Each example now states the `inspect()` / `plan()` distinction in its header, since the
  question "why does the CLI's dry run need a key when this does not?" is the obvious next
  one a reader has.
- The docs site's API page already lists `inspect()` (added at S17 when the generator was
  fixed), so the method the examples now use is discoverable.
