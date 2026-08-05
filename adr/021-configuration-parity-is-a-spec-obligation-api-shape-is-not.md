# ADR-021 — Configuration parity is a SPEC obligation; client API shape is not

**Status:** Accepted · **implements `SPEC.md` §4.3 in Python; changes no MUST**

Closes PLAN.md open item **O84** (MEDIUM), filed by the S22 fresh-eyes UX pass.

## Context

Two reference pages described the TypeScript API shape as if it were both languages'. The
repository README indexed the Configuration page as "Every option in both languages", and two
documented things could not be done in Python from what was written:

- **`timeouts`.** `reference/configuration` documented `timeouts.initialRequestMs` and
  `timeouts.paymentRetryMs` in two tables plus a section on their semantics, with no Python
  spelling anywhere. `from tx402 import Timeouts` raised `ImportError`; the real constructor took
  a flat `payment_retry_timeout_ms`, a different name in a different shape, and there was **no
  Python equivalent of `initialRequestMs` at all**.
- **Budget state.** `guides/policy` said "Two calls, and the difference matters.
  `getBudgetState()` is a synchronous snapshot of the most recent paid request;
  `queryBudgetState()` reads the store." The TypeScript block showed both. The Python block showed
  one call carrying the _name_ of the TypeScript snapshot and the _signature_ of the TypeScript
  query, so a Python reader following that sentence wrote `client.get_budget_state()` and got
  `TypeError: missing 2 required keyword-only arguments`.

Both were reported as one finding. They are not one defect, and the reason matters more than
either fix.

## The distinction SPEC already draws

**SPEC §4.3 is a language-neutral normative table.** It is titled "Configuration schema", it is
not qualified by language, and it names `timeouts.initialRequestMs` with the rule "SDK does not
silently shorten caller timeout." The Configuration page opens by asserting that "every field in
it is implemented" — which was true of TypeScript and false of Python.

**SPEC §4.1 and §4.2 are per-language export tables.** §4.1 requires `client.getBudgetState()` of
TypeScript. §4.2's Python table requires `Tx402Client`, `AsyncTx402Client`, `request`, `inspect`,
`Policy` and `Tx402Error` — and **no budget accessor at all**. The two-call split is therefore a
TypeScript-local design, not a cross-language contract.

So one of the two halves was a conformance gap and the other was not, and they cannot be fixed
the same way without either leaving a normative field unimplemented or inventing public API that
no specification asks for.

## Decision

**`timeouts.initialRequestMs` is implemented in Python. The budget-state split is documented per
language and not mirrored.**

### The field, in code

Both Python clients take `initial_request_timeout_ms: int | None = None`. Absent is the default
and is the specified behaviour — no SDK deadline, the caller's own httpx timeout governing — so
nothing changes for anyone who does not ask. When supplied it bounds the **unpaid** request only,
at the four call sites that issue one (`inspect`, `plan`, and the payment path, in each of the
sync and async transports), via the existing `with_deadline` helper.

Python keeps its **flat keyword spelling** rather than gaining a `Timeouts` object. The flat form
is idiomatic, it is what `payment_retry_timeout_ms` already shipped as, and a nested-object import
would be a second way to express configuration that the rest of the Python surface does not use.
The SPEC field name survives where it is load-bearing: a validation failure reports
`configPath: "timeouts.initialRequestMs"` in both languages, so the same mistake is diagnosed
identically (ADR-005).

A deadline on the initial request is safe in a way a deadline on the paid retry is not. Nothing
has been signed yet, so expiry is a plain `TransportError` in the `initial` phase rather than the
ambiguity `paymentRetryMs` produces. That asymmetry is now stated on the Configuration page,
because "why can I bound one and not the other" is the next question a reader has.

### The split, in prose

Python does **not** gain `query_budget_state`, and `get_budget_state` is not renamed. It is
already the store query — both keyword arguments required — and the store query answers
everything the snapshot does and more.

The snapshot answers "what did _this client object_ last pay". That is a natural question of a
TypeScript client that owns `fetch()`. It is a much less natural one of a Python client that is
an httpx transport wrapper, and answering it would mean the Python client carrying
last-paid-scope state it does not otherwise keep — new mutable state on a money path, added for
symmetry with a language rather than for a caller who asked.

Renaming `get_budget_state` was rejected separately: it is shipped public API, the name is
accurate for what it does, and a rename would break every caller to make a documentation sentence
read more evenly.

## Consequences

- SPEC §4.3 is now implemented in full in both languages, and the Configuration page's opening
  assertion is true again.
- `reference/configuration` gives both spellings for every field whose spellings differ, and says
  which language offers a field when only one does.
- `guides/policy` states the budget-state asymmetry as a deliberate design rather than showing a
  Python block under a sentence describing two TypeScript calls, and says why.
- The README no longer indexes Configuration as "Every option in both languages"; it now promises
  both languages' **spellings**, which is what the page delivers.
- `/reference/api-python/` remains absent. The gap is unfilled rather than mislabelled — the
  sidebar honestly says "TypeScript API surface" — but Configuration's generic "read the API
  reference" link sent Python readers there under a name that did not warn them, and now names
  the language and points Python readers at the package README instead.
- The Python public surface grows by one keyword argument on each client and nothing else.
  `Timeouts` is deliberately not exported, and a regression asserts it stays that way so the
  decision is not quietly reversed by someone reading only the TypeScript page.
