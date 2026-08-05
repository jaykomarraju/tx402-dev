# ADR-023 — Behavioural prose is written from execution, not from reading

**Status:** Accepted · **a process rule; changes no MUST and no code**

Filed at S31, after the seventh consecutive fresh-eyes pass returned findings and three of the
four were sentences that earlier remediation sessions had written.

## Context

Seven cold passes have now run against this project. The picture they paint is consistent and,
read carefully, encouraging about the software:

- **S22, S24, S26 and S30 found no defect in payment behaviour at all.** Every product guarantee
  held under deliberate attack — policy before signing, atomic reservation, deterministic
  routing, no signature on a dry run, cross-language agreement, no key in any serialized form.
- Across those seven passes exactly **two** software defects were found (O93's duplicated
  advisory and O96's misclassified re-challenge), and both were in how an outcome was _reported_
  rather than in what was done with money.
- Everything else — the substantial majority — was **prose that was wrong about the software**.

The prose defects are not evenly distributed either. A growing share of them were introduced by
the remediation sessions themselves, and the mechanism is identical every time.

**A remediation session fixes a defect, understands the surrounding code while doing so, and then
writes an explanatory sentence describing what a caller observes — from that understanding,
without running it.** The sentence is plausible, is written with the confidence of someone who
has just read the implementation, and is wrong.

Documented instances:

| Item | Sentence                                                             | Written at | What was actually true                                                         |
| :--- | :------------------------------------------------------------------- | :--------- | :----------------------------------------------------------------------------- |
| O83  | Exit 9 means "the money _did_ move"                                  | S19        | It fires with `paid: false` and a zero on-chain delta too                      |
| O94  | A `null` identifier "never" means no payment                         | S19        | The `missing-payment-response` fixture falsifies it                            |
| O97  | `request.failed` is `warn` **or** `error`                            | S27        | Both fired, on every ambiguous path, in TypeScript                             |
| O103 | `payment.completed` warns when settlement evidence is absent         | S25        | It also warns when evidence is present and delivery failed                     |
| O100 | On a redirect "you get the response, see the `Location`, and decide" | S29        | Both redirect kinds **throw**, and the same-origin error carries no `Location` |
| O102 | "Each event is emitted exactly once per request"                     | S29        | Seven of the ten are emitted once per **attempt**                              |

The last two are the sharpest illustration. They were written in the **same commit** as ADR-022,
whose own text diagnoses the cause of O97 as: _"it had been written by reading the two `emit` call
sites and inferring they were alternatives, rather than by running them."_ The lesson was
identified, written down as the finding of the session, and violated twice in the act of writing
it down.

## Why the existing guards do not catch this

The project's regression suites are good and have caught real recurrences. They cannot catch this
class, for a structural reason worth stating:

**Every one of these was a brand-new sentence.** A guard rejects a pattern that has been seen
before — `PLAN.md`, `SPEC §4.3`, "atomic units, if you prefer", "the payment may have settled"
twice. A sentence written for the first time in a remediation commit matches no pattern, because
the pattern does not exist until the next cold pass names it.

Adding a wording rule per finding therefore produces a suite that grows linearly and still fails
to catch the next one. Seven sessions of evidence support this: each added guards, and each was
followed by a pass that found new prose.

## Decision

**A sentence describing what a caller observes may not be written from reading source. It must be
produced by running the thing, and the observation recorded in the session's `PLAN.md` entry.**

"What a caller observes" means, concretely: what is returned or thrown; what an error's `code`,
`context` and `details` carry; which events fire, how many times, and at what level; what an exit
code is; what a command prints; what a documented input is accepted or rejected as.

Three obligations follow.

**1. Execute first.** Before writing such a sentence, run the case and capture the output. The
project ships everything needed: seventeen merchant scenarios, RPC stubs, and a logger interface
that takes four methods. A survey across all scenarios takes under a minute.

**2. Record the observation.** The captured output goes in the `PLAN.md` session entry, not just
in a scratch file. A future session reading "seven of ten events are per-attempt" should be able
to see the run that established it, and a future cold pass disagreeing with a claim should be
able to see what was measured and when.

**3. Guard the fact, not the wording.** Where a page states a behavioural contract, the regression
derives that contract from the running client and compares the page to it. The S31 suite is the
shape: it exercises the client, counts the events, reads the error details, and asserts the page
agrees — so the page cannot drift from the code in either direction, and a future rewrite of the
same sentence is checked against behaviour rather than against a banned phrase.

## Consequences

- Remediation sessions are slower by the minutes it takes to run a survey. That is the entire
  cost, and it is trivially less than a cold pass plus a remediation round, which is what each of
  these six sentences has cost.
- `PLAN.md` entries grow captured output. This is a feature: the alternative is claims whose
  provenance is a session's confidence.
- The regression suites stop accumulating one wording rule per finding.
- **This ADR does not make the prose correct.** It makes a specific, repeatedly-observed failure
  mode detectable before it ships. A sentence can still be badly written, misleading by omission,
  or wrong about something no fixture exercises.

## What this says about the product

Worth recording plainly, because seven rounds of findings can read as seven rounds of a product
failing, and that is not what happened. **No cold pass has found tx402 mishandling money.** The
defects have been concentrated in the documentation, and increasingly in the documentation
written by the sessions fixing the documentation. That is a process failure with a process fix,
and it is the one this ADR is for.
