# ADR-018 — The policy scope is the normalized merchant host, in both languages

**Status:** Accepted · **fixes `SPEC.md` §5.3 conformance; changes no MUST**

Closes PLAN.md open item **O45** (HIGH), filed by the S15 pre-publication audit, and
publishes the `SpendStore` contract half of **O54** (MEDIUM).

**Amended S15d** — see "Amendment (S15d)" below, which fixes the canonical form of the host
itself and closes O58.

## Context

SPEC §5.3 gives every `SpendReservation` a `policyScope: string` and says nothing about what
goes in it. SPEC §4.3 says `spendStore` "must support atomic reserve/commit/release" and
defaults to `MemorySpendStore`. The README and the policy guide describe the point of
supplying your own: a fleet of agent processes sharing one hourly cap.

The two implementations chose different values.

- **Python** used the **normalized merchant host**, computed per request.
- **TypeScript** assigned a **UUID at client construction** and used it for every request
  that client ever made.

Both satisfy "a string", and the conformance vectors never compared across clients, so
nothing caught it. What it means in practice is two defects pointing in opposite
directions:

1. **Two TypeScript clients sharing one store see two ledgers for one merchant.** The
   audit planned the same `https://api.example.com/resource` through two clients with one
   recording store and watched two distinct UUID scopes arrive. The documented fleet-wide
   cap silently degrades to per-client.
2. **One TypeScript client calling two merchants sees one ledger.** A per-host cap that is
   actually per-client refuses a second merchant because the first had spent, which is not
   what `maxPerHour` promises.

A third finding travelled with it: `client.getBudgetState()` returned a snapshot that was
initialised to zeros and refreshed only after a paid request, against the client's own UUID
scope. Against a store seeded with committed 7 / reserved 3 it returned hard-coded zeros and
the store saw **no read at all**. Python instead required explicit `policy_scope` and
`asset_id` arguments, so the two languages' public budget surfaces did not match either.

## Decision

### 1. `policyScope` is the normalized merchant host

Computed per request, from the URL actually being sent, by the same
`normalizePolicyHost` / `normalize_policy_host` that `policy.allowedDomains` uses. Both
functions are exported so a caller can compute the key themselves — a ledger whose key
cannot be derived cannot be queried.

The scope is **host-only**: no scheme, no port, no path. That follows the domain policy's
own normalization, so "which merchants may I pay" and "which ledger does this payment count
against" answer to the same identity. A consequence worth stating: two merchants on
different ports of one host share a cap.

To a store the scope is **opaque**. A store compares it for equality and never parses it.

### 2. The budget surface is the same in both languages

- **Query**, reading the store: TypeScript gains
  `client.queryBudgetState({ policyScope, assetId, nowEpochMs? }): Promise<BudgetState>`,
  matching Python's existing `client.get_budget_state(policy_scope=…, asset_id=…)`.
- **Snapshot**, SPEC §4.1's `client.getBudgetState()`: still synchronous and still the
  ledger as of the most recent paid request, but now **self-describing** — `BudgetState`
  carries `policyScope` and `assetId`, absent only on the empty pre-payment snapshot — and
  actually read from the store rather than assembled from zeros.

### 3. `SpendStore` is a published contract in both languages

TypeScript exported an interface; Python exported only `MemorySpendStore`, annotated its
client and policy parameters with that concrete class, and provided no protocol. Strict type
checking therefore rejected the supported extension. Python gains:

- `SpendStore`, a `runtime_checkable` `Protocol` with the four keyword-only methods;
- `assert_spend_store`, a structural check run at construction so a lookalike is refused
  **there** rather than discovered mid-payment after a signature exists;
- `tx402.spend_store_contract.check_spend_store`, a runnable conformance suite **shipped in
  the wheel** — an adapter author cannot import this repository's tests;
- `spend_store` parameters annotated with the protocol, not the class.

And one small change with real consequences: `spend_store or MemorySpendStore()` becomes
`MemorySpendStore() if spend_store is None else spend_store`. A valid adapter that defines
`__len__` and is empty at startup is falsey, and `or` silently replaced it — turning a
fleet-wide cap into a per-process one with no error anywhere.

The behavioural contract an adapter must honour is written **once**, in prose, and carried
verbatim on both the TypeScript interface and the Python protocol, so the two languages
cannot come to describe different contracts.

## Rationale

**Why the host and not the client.** A budget belongs to a counterparty, not to an object.
The cap a caller sets is "no more than 10 USDC per hour to this merchant"; if the key is the
client instance, then constructing a second client doubles the cap, and doing so is the
ordinary thing a program does when it adds a worker. The UUID was defensible only as long as
`MemorySpendStore` was the only store, and SPEC §4.3 makes it not the only store.

**Why not the full origin.** Scheme is fixed — SPEC requires HTTPS — and including the port
would let a merchant that moves from 443 to 8443 reset its own cap. Matching
`allowedDomains`' normalization keeps one notion of merchant identity in the SDK.

**Why keep the zero-argument `getBudgetState`.** SPEC §4.1 lists it, and a synchronous
snapshot is genuinely useful after a call. Making it self-describing is what turns it from
misleading into merely narrow: a caller can see which ledger the figures belong to, and
reach for `queryBudgetState` when they want another.

**Why a shipped contract suite rather than documentation.** The contract's hardest clause is
that `reserve` is atomic, and no amount of prose makes that checkable. `check_spend_store`
runs twenty concurrent one-unit reservations against a five-unit cap and requires exactly
five to be admitted — a store that reads, decides, then inserts passes every other rule and
fails only here, which is exactly where money is lost.

## Consequences

- **TypeScript's ledger keys change.** Any process that persisted a UUID scope from a
  pre-0.1.0 build reads an empty ledger under the new key. Nothing has shipped under those
  keys, so this is theoretical, and it is recorded rather than left to be discovered.
- **`BudgetState` gains two optional fields** in both languages.
- **`Tx402Client` gains `queryBudgetState`**; `getBudgetState` keeps its SPEC §4.1
  signature.
- **Python's public surface gains** `SpendStore`, `assert_spend_store`,
  `check_spend_store`, `SpendStoreContractError`, and `normalize_policy_host`.
- **A store that was accepted by duck typing and is missing a method is now refused at
  construction**, with `details.missing` naming what it lacks.
- **Cross-language regression tests** cover a shared store across two clients, two hosts on
  one store, a falsey adapter, and a lookalike. All were confirmed to fail on the S15
  commit.

## Amendment (S15d) — the canonical host is the A-label, and both languages produce it

Closes PLAN.md open item **O58** (MEDIUM), filed by the S15c audit re-run.

This ADR made `normalizePolicyHost` / `normalize_policy_host` "the public way to derive the
exact key a client reserves under" and left the _form_ of that key undefined. The two
languages promptly chose different ones for the same merchant.

- **TypeScript** returned `new URL(url).hostname`, which is WHATWG ToASCII — so
  `https://bücher.example/x` and its punycoded twin both normalize to
  `xn--bcher-kva.example`.
- **Python** returned `urlsplit(url).hostname`, which is the U-label the caller typed —
  `bücher.example`. Its _client_, meanwhile, normalized `str(httpx.Request.url)`, and httpx
  had already punycoded it, so the ledger key was `xn--bcher-kva.example`.

The consequences were a caller querying a ledger their own client had never written to, and
a Unicode `allowed_domains` entry that could not match any real request host — Python
therefore refusing a domain TypeScript allows. Neither can authorize an unintended host: the
allowlist failure is restrictive, which is why this was filed MEDIUM and not HIGH.

**Decision: the canonical policy host is the A-label (ASCII) host** — what a WHATWG URL
parser produces — lowercased, with **one** trailing root dot removed, IPv6 literals kept in
brackets. The A-label is chosen over the U-label because it is the host that actually goes
on the wire, it is what every store already holds, it is a pure-ASCII map key with no
normalization form to argue about, and TypeScript is the reference implementation
(ADR-005).

**What changes:** Python only, and nothing about the money.

- `normalize_policy_host` punycodes through **httpx**, the parser that already converts the
  host of every request the SDK sends, rather than a second IDNA implementation that could
  drift from it. `.lower()` and a single-dot strip finish the job. Delegating is the point:
  helper and client now cannot disagree, instead of merely agreeing today.
- Two smaller alignments travel with it, both previously unnoticed cross-language drift in
  the same function: an IPv6 literal is `[::1]` in both languages rather than `::1` in
  Python, and `a.test..` strips **one** dot in both rather than all of them in Python.
- An unencodable host raises `ValueError`, which `policy.allowed_domains` already converts
  into `TX402_CONFIG_INVALID`.
- **`normalizePolicyHost` is unchanged in TypeScript.** Its allowlist normalizer now calls
  it instead of repeating its body, which is how the two came to drift in the first place.

**A shared parity table pins it.** The same eight hosts — Unicode, punycoded, uppercase
Unicode, `ß`, IPv6, trailing dot, double dot, and the root label — are asserted to produce
identical output in both suites, so a future edit to either helper alone fails a test rather
than being discovered by an audit.

**O43 is unaffected and stays accepted.** `https://./x` still normalizes to the empty string
in both languages, for the reasons recorded there.

## Amendment, S17 — the one-dot rule is normative, and now pinned outside the suites

**Decision: `normalizePolicyHost` strips exactly one trailing dot, and that is the contract.
The `pnpm fuzz` gate was wrong, not the normalizer.**

The gate asserted, for every non-empty host, that re-normalizing its own output returned that
output unchanged. That is strictly stronger than this ADR promises and the two cannot both
hold: `https://a.test..` → `a.test.` → `a.test`. Because the fuzz seed is wall-clock derived,
any push could go red without a code change, and one did — measured at 10 failures in 200
deterministic seeds (5.0%) at CI's 200,000 iterations (PLAN.md O62).

Which side to correct was a real choice, and the normalizer keeps its behaviour for four
reasons. The one-dot rule is what this ADR already documents and what the parity table above
already asserts. `a.test..` is not a resolvable DNS name, so no reachable merchant is
affected. Changing it would move the spend-ledger scope key — the identity under which money
is reserved — for a gain of nothing. And it is **not** a security question in either
direction: `normalizeDomainPattern` routes allowlist entries through this same function, so a
pattern and a host receive identical treatment and matching stays fail-closed both ways.

Two things changed instead, and they close the gap the disagreement revealed — that the rule
was only ever asserted _inside_ each language's own suite:

- **The gate now asserts the contract, and asserts it from the input side.** An output-side
  check cannot see this rule at all: a normalizer that stripped _every_ trailing dot emits a
  host that never ends in one, so any assertion about re-normalizing the output would agree
  with it. The gate now checks that the output is the lowercased hostname with exactly one
  trailing dot removed, and separately that repeated application converges. Verified by
  mutation: a strip-all normalizer and a strip-none normalizer are both rejected, and the
  shipped one passes — none of which the previous assertion could distinguish.
- **Six conformance vectors under `policy.host-normalization` pin it across languages**,
  including `double-dot` for the exact case the gate and the implementation disagreed about.
  A parity table inside two suites is two assertions; a vector is one fixture both languages
  must answer identically.

## References

- `SPEC.md` §4.1, §4.3, §5.3, §6.3
- `packages/tx402/src/core/ledger.ts`, `packages/tx402-python/src/tx402/ledger.py`,
  `packages/tx402-python/src/tx402/spend_store_contract.py`
- ADR-007 (local state), ADR-017 (store failure semantics)
- PLAN.md open items O45, O54 (opened S15, decided S15b); O58 (opened S15c, decided S15d)
- `packages/tx402/src/core/policy.ts`, `packages/tx402-python/src/tx402/policy.py`
