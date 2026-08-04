# tx402 — Implementation Plan (Living Document)

> **This file is the living plan and is authoritative for sequencing.** It MUST be updated at the
> end of every session — status board (§7), open items (§9), and the handoff prompt (§8.1).
> Read it first in every new session.

---

## 1. Context

`tx402` is a resilient, non-custodial **buyer-side** SDK for the x402 HTTP payment protocol, shipping
in TypeScript and Python. It wraps a normal HTTP client, interprets `402 Payment Required`
challenges, enforces local spend policy _before_ any key is touched, deterministically selects a
payment route across offered chains, signs an authorization, and retries the request — turning
~100 lines of fragile agent glue code into a 3-line integration.

**Why now:** AI agents run long autonomous loops where a single dropped payment handshake at step 45
of 50 discards all upstream work. Existing clients hard-wire one facilitator and one chain. The
protocol layer is settled (x402 v2); the gap is resilience and developer ergonomics.

**Current state:** _(updated end of S7)_ **the TypeScript SDK chooses between Base and Solana
deterministically and pays on the one it chose.** M5 landed the SPEC §6.4 RoutePlanner and the
SPEC §6.5 HealthIndex: candidates are scored concurrently, one balance query per unique
network/asset/owner, ordered by a total key cascade that is a pure function of the candidates, and
the winner is paid. The two per-adapter circuits M3 and M4 carried are **gone** — there is now one
health index per client, shared by both RPC pools, and `client.resetHealth()` clears it in one call.
T-004, T-005, T-008, and T-020 are green. The TypeScript runner executes all 59 shared vectors
through M5; Python still claims M2 and catches up at S9/S10. Only the re-challenge loop and
`maxPaidAttempts` remain unwritten (M6).

**Sources of truth, in precedence order:**

1. `SPEC.md` — governs all v0.1 implementation behavior (its §0 says so explicitly).
2. `PRD.md` — product intent; explains _why_, never overrides _what_.
3. This plan — sequencing and process only. It never overrides SPEC behavior; where it deviates from
   SPEC, an ADR is required and is listed in §3.

**Development happens in `tx402-dev`.** The public open-source repo is a later migration; keep all
metadata (repo URLs, badges) behind a single constant so the move is a one-file change.

---

## 2. Locked Decisions (from this planning session)

| #   | Decision                                                                                                                                                                                                          | Consequence                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Package name is `tx402`, unscoped, on both npm and PyPI.** No `@tx402` org.                                                                                                                                     | Every `@tx402/sdk` reference in SPEC.md §4.1, §13, §16 reads `tx402`. Requires **ADR-009**.                                                                                                                                                                                                             |
| D2  | **One npm package `tx402`** exposing the SDK at `.` and the CLI via a `bin` entry.                                                                                                                                | `npx tx402 call ...` works with zero extra install. Merges SPEC §3.1's separate `/packages/cli`. Covered by **ADR-009**. CLI code lives outside the core import path so it does not count against the size gate.                                                                                        |
| D3  | **Reserve both names by publishing a `0.0.0` placeholder.** npm immediately (already authed as `jay.komarraju`); PyPI as soon as an API token exists.                                                             | npm has no true reservation — publishing is the only hold. Placeholder is public; npm unpublish is only possible within 72h.                                                                                                                                                                            |
| D4  | **Bundle-size gate re-baselined.** Blocking gate: tx402's **own emitted code** < 25 KiB gzipped. Informational: total core-path footprint incl. `@x402/core` + zod, ceiling frozen from a real measurement at M1. | SPEC §12.3's literal "<25 KiB core import path" is unreachable — measured `@x402/core` ESM at ~27 KiB gzipped alone, plus zod ~13 KiB. Requires **ADR-008**.                                                                                                                                            |
| D5  | **TypeScript first through M6, then Python catches up against frozen conformance fixtures.**                                                                                                                      | Matches SPEC ADR-005 (TS is the reference implementation). Python inherits a settled design instead of tracking churn.                                                                                                                                                                                  |
| D6  | **`retryable` is derived from a six-value `retryability` classification; per-error data lives in `details`, not in the closed `Tx402ErrorContext`.**                                                              | SPEC §8's Retryable column has six values while §4.2 names one boolean. Requires **ADR-011**. Only `TransportError` reports `retryable: true`.                                                                                                                                                          |
| D7  | **Manifests are signed over domain-separated tx402 canonical JSON; trusted keys are compiled into each package.**                                                                                                 | SPEC §5.4 defines the signature member but not the bytes it covers. Requires **ADR-012**. Adds `cryptography` to the Python core install — CPython has no Ed25519 and SPEC §3.2 forbids writing one.                                                                                                    |
| D8  | **ADR-008's total-core size ceiling is 28 KiB from the measured M2 baseline; the independent 25 KiB own-code limit is unchanged.**                                                                                | M2's policy/ledger are necessarily reachable from `createTx402Client`. Measured 25.79 KiB total / 10.99 KiB own; explicit ADR-008 amendment, no dependency change. **Superseded by D9.**                                                                                                                |
| D9  | **Chain adapters are reached through a lazy `import()` from the core path, and the total-core ceiling becomes a tracking number re-baselined by ADR amendment (30 KiB at M3).**                                   | Keeps SPEC §4.1's `signers: { evm, solana }` config exactly as written while `@x402/evm` and `viem` stay off the size-gated core path. Amends **ADR-008**; the blocking own-code gate stays at 25 KiB and never moves.                                                                                  |
| D10 | **The circuit breaker exists exactly once, in `core/health.ts`.** RPC pools hold endpoint lists and failure classification; they hold no circuit state.                                                           | Closes O19 and O22 structurally. `EvmRpcPool` and `SvmRpcPool` consult and report into the client's single `HealthIndex`, and `CIRCUIT_OPEN_MS` re-exports `HEALTH_OPEN_MS`. No ADR needed — SPEC §6.5 describes one health index; M3/M4's per-pool circuits were the deviation, and this removes them. |

---

## 3. Upstream Reality Check (verified against `@x402/*` v2.20.0 and PyPI `x402` 2.17.0)

I downloaded and read the published upstream packages. These findings shape the architecture and
several must be reconciled with SPEC.md via ADR.

**Confirmed as SPEC describes:**

- v2 headers are exactly `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`
  (`X-PAYMENT` / `X-PAYMENT-RESPONSE` are v1 legacy). SPEC ADR-004 is accurate.
- `@x402/core` exports the full codec: `encode/decodePaymentRequiredHeader`,
  `encode/decodePaymentSignatureHeader`, `encode/decodePaymentResponseHeader` from `@x402/core/http`.
- `ExactEvmScheme` (`@x402/evm`) and `ExactSvmScheme` (`@x402/svm`) implement `SchemeNetworkClient`
  — `createPaymentPayload(x402Version, requirements, context?)`. This is the signing seam.

**Divergences requiring reconciliation (fold into ADR-010, "Upstream Envelope Reconciliation"):**

| Finding                                                                                                                                                                                                                           | Impact                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upstream `PaymentRequirements` field is **`amount`**, not `amountAtomic`. `PaymentRequired` is `{x402Version, error?, resource, accepts[], extensions?}`.                                                                         | SPEC §5.1/§5.2 names are tx402's _internal normalized_ schema (SPEC §5 says exactly this). Keep them; map at the decoder boundary. No behavior change.                                                                                     |
| Upstream `resource` is `{url, description?, mimeType?, serviceName?, tags?, iconUrl?}` — **there is no `method` field**.                                                                                                          | SPEC §5.1 requires binding the challenge to method. Bind to the **locally known** request method (tx402 issued the request), and validate `resource.url` origin against the requested URL. Method binding is local, not challenge-derived. |
| Upstream `PaymentRequired` carries **no timestamp**.                                                                                                                                                                              | SPEC's `routing.maxQuoteAgeMs` ("reject older PaymentRequired timestamps _when present_") is inert unless a timestamp appears in `extra`. Implement the check as conditional; document it as a no-op for standard v2 challenges.           |
| Solana CAIP-2 IDs upstream are genesis-hash based: mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.                                                                           | `solana:mainnet` in SPEC §4.1's config example is an **alias**. The release manifest must carry canonical IDs plus an alias map; policy/config accept either and normalize to canonical. SPEC §7.2 already anticipates this.               |
| `ClientEvmSigner` is `{address: 0x string (sync property), signTypedData({domain,types,primaryType,message})}` plus optional `readContract`/`signTransaction`/`getTransactionCount`/`estimateFeesPerGas`.                         | SPEC §7.1's `EvmSigner.getAddress(): Promise<...>` needs a thin adapter (async→sync property). Keep SPEC's async interface as tx402's public contract; adapt internally.                                                                   |
| `ClientSvmSigner` **is** `@solana/kit`'s `TransactionSigner` (peer dep `@solana/kit >= 5.1.0`).                                                                                                                                   | SPEC §7.2's `SolanaSigner {getPublicKey, signTransaction}` is tx402's own abstraction; write an adapter to `TransactionSigner`. `@solana/kit` becomes an optional peer, loaded only via the `tx402/solana` entry.                          |
| Upstream `x402Client` **already has** `policies: PaymentPolicy[]` and `paymentRequirementsSelector`, plus client hooks (`onBeforePaymentCreation` can abort, `onPaymentCreationFailure`/`onPaymentResponse` can signal recovery). | Do **not** reimplement the protocol. See §4 for the exact seam.                                                                                                                                                                            |
| Python `x402`'s httpx integration ships **async only** (`x402AsyncTransport`); sync is a `requests` `HTTPAdapter`.                                                                                                                | SPEC §4.2 requires a **sync** `Tx402Client` on an httpx-compatible transport. tx402 must implement its own `httpx.BaseTransport`. Fine — tx402 owns the loop anyway.                                                                       |

---

## 4. Architecture: the seam with upstream

**tx402 owns the request loop. Upstream owns the protocol envelope and the signing.**

SPEC §6's state machine requires behavior upstream's `wrapFetchWithPayment` does not provide:
budget reservation before signing, health-scored deterministic route selection, replayable-body
handling, ambiguous-payment classification, and paid-redirect blocking. So tx402 implements the loop
directly and calls upstream only at two points:

```
tx402 Tx402Client.fetch()
  │
  ├─ transport ──────────────── own code (fetch / httpx.BaseTransport)
  ├─ decode PAYMENT-REQUIRED ── @x402/core/http  decodePaymentRequiredHeader()   ◄── upstream
  ├─ normalize ──────────────── own code (NormalizedPaymentRequired, SPEC §5.1)
  ├─ PolicyEngine ───────────── own code (integer atomic, pre-sign, SPEC §6.3)
  ├─ RoutePlanner + HealthIndex own code (deterministic ordering, SPEC §6.4/§6.5)
  ├─ SpendLedger reserve ────── own code (atomic, SPEC §5.3)
  ├─ create payload ─────────── ExactEvmScheme / ExactSvmScheme                  ◄── upstream
  │                             .createPaymentPayload(2, selectedRequirement)
  ├─ encode PAYMENT-SIGNATURE ─ @x402/core/http  encodePaymentSignatureHeader()  ◄── upstream
  ├─ paid retry ─────────────── own code (one signature, one attempt, SPEC §6.7)
  ├─ decode PAYMENT-RESPONSE ── @x402/core/http  decodePaymentResponseHeader()   ◄── upstream
  └─ SpendLedger commit ─────── own code
```

**Why not use `x402Client`'s `policies`/`selector` hooks instead?** Those run _inside_ upstream's
payload-creation call, after tx402 must already have reserved budget and chosen a route. tx402
pre-selects a single requirement and hands upstream exactly that one. Register the scheme clients on
a bare `x402Client` (or call `ExactEvmScheme`/`ExactSvmScheme` directly) so upstream's default
"first available" selector never gets a choice to make.

**Consequence for ADR-002 (facilitators):** SPEC is already correct here — the buyer never calls
`/verify` or `/settle`. The merchant owns settlement. tx402's "failover" is across _merchant-offered
requirements and RPC endpoints_, not across facilitator settle calls. The PRD's framing of
"facilitator failover" is superseded by SPEC ADR-002/ADR-003. Do not build facilitator racing.

---

## 5. Repository Layout

```
tx402-dev/
  PLAN.md                       # this document, living
  PRD.md  SPEC.md               # frozen sources of truth
  adr/                          # ADR-001..007 transcribed from SPEC §2, plus new ones
  package.json                  # private workspace root
  pnpm-workspace.yaml
  packages/
    tx402/                      # npm package "tx402"  (SDK + CLI)
      src/
        index.ts                # core import path — size-gated
        core/                   # transport, protocol, policy, money, ledger, routing,
                                #   health, errors, diagnostics, manifest
        evm/                    # export "tx402/evm"     — optional, viem + @x402/evm
        solana/                 # export "tx402/solana"  — optional, @solana/kit + @x402/svm
        signers/                # optional private-key convenience adapters (isolated, SEC-001)
        cli/                    # bin entry — outside core path
    tx402-python/               # PyPI package "tx402"
      src/tx402/{core,evm,solana,signers}/
  core-spec/                    # language-neutral; neither SDK keeps a private copy
    schemas/                    # JSON Schema 2020-12 for every SPEC §5 shape
    conformance/
      index.json                #   vector index with per-file sha256 (SEC-007)
      vectors/{errors,canonical-json,manifest,protocol}/
    manifests/
      bundled.manifest.json     #   signed source of truth
      keys/                     #   *.pub.json committed; *.private.pem gitignored
  examples/{typescript,python}
  tests/{integration,fault-injection,performance,security}
  docs/{api,operations,security}
  tools/
    size-gate/                  # ADR-008 two-part budget
    manifest-signer/            # keygen / sign / verify / embed  (ADR-012)
    conformance/                # fixture index build + integrity check
    test-merchant/              # deterministic 402 server, programmatic + CLI
    evm-rpc-stub/               # deterministic local eth_chainId / balanceOf JSON-RPC
```

**Generated files — never hand-edit.** `packages/tx402/src/core/bundled-manifest.ts` and
`packages/tx402-python/src/tx402/bundled_manifest.py` are emitted by
`node tools/manifest-signer/index.js embed`, and `core-spec/conformance/index.json` by
`node tools/conformance/index.js build`. Both are excluded from prettier/ruff formatting and both
have a test asserting they still match their source, so a hand edit fails CI even if the tool is
never re-run.

Deviates from SPEC §3.1 only by merging `/packages/cli` into `packages/tx402` (D2, ADR-009).

**Toolchain note:** `pnpm` and `uv` are **not installed** on this machine (`node` v20.19.5,
`python` 3.13.5, `npm` 10.8.2 are present). Session 1 installs them.

---

## 6. Session Plan

Sessions are elastic — if one runs long, split it and renumber. Each session ends with the §8
protocol (update this file, commit, emit handoff prompt). Milestone IDs map to SPEC §14; test IDs to
SPEC §12.2.

### S1 — Bootstrap & Reserve

- `git init` state resolved: first commit with `PRD.md`, `SPEC.md`, `PLAN.md`.
- Install `pnpm` + `uv`. Scaffold workspace, `packages/tx402` (tsup/tsc build, ESM primary, `bin`),
  `packages/tx402-python` (hatchling, py3.10–3.13).
- Transcribe SPEC §2 ADR-001..007 into `adr/`. Author **ADR-008** (size gate, D4),
  **ADR-009** (single unscoped package + CLI bin, D1/D2), **ADR-010** (upstream envelope
  reconciliation, §3 above).
- Pin `@x402/core@~2.20.0`, `@x402/evm`, `@x402/svm`, PyPI `x402==2.17.*` in lockfiles.
- CI skeleton (GitHub Actions): lint, typecheck, test, build, size-gate, on Linux + Node 20/22 +
  Python 3.10–3.13.
- **Reserve names (D3):** publish `tx402@0.0.0` placeholder to npm. Prepare the PyPI placeholder +
  publish runbook; publish the moment a token is available.
- _Exit:_ both scaffolds build and test-run green in CI; npm name held; ADRs merged.
- _Blocked on user:_ PyPI account + API token.

### S2 — M0: Spec Fixtures & Frozen Names

- JSON Schemas for `NormalizedPaymentRequired`, `RouteCandidate`, `SpendReservation`/`SpendEntry`,
  `ReleaseManifest` (SPEC §5.1–§5.4).
- Release manifest: ed25519 signing tool, bundled manifest with Base Mainnet, Base Sepolia,
  Solana Mainnet, Solana Devnet — **canonical CAIP-2 IDs plus alias map** (§3).
- Conformance fixture format + runner contract; first valid/invalid v2 vectors.
- Full error taxonomy (SPEC §8) as code, both languages.
- Deterministic test merchant server (configurable 402 challenges, retry validation).
- _Exit:_ public names frozen and reviewed. **This is the last cheap moment to rename anything.**

### S2 — M0 (delivered)

Landed as specified, plus three things worth carrying forward: coverage thresholds were enforced
at S2 instead of S4 (O11), the conformance runner is **two-stage** so vectors written ahead of
their milestone still validate against the frozen names, and `IMPLEMENTED_THROUGH` in each runner
must be raised to claim a milestone — the runner fails if a vector at or below it has no handler.

### S3 — M1: TS Transport + Protocol Core

- `createTx402Client`, `client.fetch`, `client.inspect`, `getBudgetState`, `resetHealth`.
  (`isTx402Error` and the full error taxonomy already ship — S2.)
- Raise `IMPLEMENTED_THROUGH` to `"M1"` in `packages/tx402/test/conformance/runner.ts` and
  register the `protocol.decode-payment-required` Stage B handler. The 11 seed vectors already
  carry their expected `normalized` output, `headerHash`, and per-requirement `rawHash`.
- Strict decode via `@x402/core/http` + tx402 limits (base64 strict, ≤64 KiB, JSON depth ≤16,
  duplicate-key rejection, ≤32 requirements — SPEC §6.2, SEC-006).
- Replayable body capture + `bodyFactory`; reserved-header rejection; HTTPS-only with
  `allowInsecureLocalhost`; paid-retry same-origin redirect block.
- Redacting diagnostics event stream (SPEC §10, SEC-003).
- **Measure and freeze the informational size ceiling per ADR-008.**
- _Exit:_ T-001, T-009, T-013, T-018 green.

### S3 — M1 (delivered)

Landed the immutable TypeScript client shell and request path through the first 402, including
strict upstream decode, tx402 normalization/hashes, replay capture/`bodyFactory`, reserved-header
and HTTPS enforcement, the paid-redirect safety seam, and redaction-safe diagnostics. Both runners
now claim M1 and execute the shared decoder vectors; the Python addition is deliberately limited to
that frozen conformance boundary, while its public HTTP client remains scheduled for S9. O4's total
core ceiling is frozen and enforced at 24 KiB, and O15's oversized vector is generated from a
compact recipe. No policy, routing, ledger, or signer code was pulled forward.

### S4 — M2: TS Policy + Ledger

- Money parser: decimal-string → integer atomic units; reject JS `number` (ADR-006).
- PolicyEngine in SPEC §6.3 order; domain patterns on normalized host; network/scheme/asset gates.
- `SpendStore` contract + `MemorySpendStore`: atomic reserve/commit/release, 120 s TTL, rolling
  3 600 000 ms window over committed + active reservations.
- Request fingerprinting (SEC-009) with golden vectors for later Python parity.
- _Exit:_ T-006 (<2 ms, signer count 0), T-007 (concurrent atomicity) green; property tests green.

### S4 — M2 (delivered)

Landed canonical decimal-string money parsing with explicit JS-number rejection, an immutable
PolicyEngine that preserves SPEC §6.3's domain → network → scheme/asset → per-request → rolling-hour
→ conditional timestamp order, and manifest-backed CAIP-2 alias/asset enforcement. The atomic
MemorySpendStore owns the authoritative cap comparison and insert, with idempotent commit, release,
late evidence handling, 120-second expiry, and inclusive rolling-hour accounting. Six generated
index-backed M2 vectors freeze SEC-009 fingerprints and ledger transitions in TypeScript/Python.
ADR-008 was explicitly amended after the required core grew past M1's interim total ceiling; the
own-code limit remains unchanged. O16's action runtimes were upgraded without changing the Node 20
application compatibility leg.

### S5 — M3: TS Base / EVM Adapter

- `EvmSigner` public interface → `ClientEvmSigner` adapter (§3).
- `ExactEvmScheme` wiring; USDC balance reads; **chain-ID verification before signing** (mismatch
  opens circuit, tries next RPC); optional `privateKeyToAccount` convenience adapter isolated under
  `tx402/signers` per SEC-001.
- _Exit:_ Base local + Base Sepolia paid calls pass.

### S5 — M3 (delivered)

Landed the Base adapter and, with it, the first end-to-end paid call. `EvmSigner` (SPEC §7.1) is a
core-path type declaration; its implementation, `@x402/evm`, and `viem` stay behind a lazy
`import()` so the size-gated core never loads them. The adapter is more than a shape bridge: it
re-derives the approved plan and asserts every field of upstream's EIP-712 message against it —
chain, token contract, domain, payer, recipient, amount, `validAfter`, `validBefore`, nonce length —
before the caller's signer is invoked, and it attaches SPEC §6.6's human-readable presentation
alongside the typed data. The authorization lifetime bound is applied by handing upstream a
requirement whose `maxTimeoutSeconds` is already clamped to `min(60, merchant bound)`, while the
merchant's own offer still goes on the wire as `accepted`.

A minimal JSON-RPC client (`eth_chainId`, `eth_call` of `balanceOf`, and nothing else) enforces
SPEC §7.1's rule that chain identity is verified on the same endpoint that serves the balance, on
every read, with a mismatch opening that endpoint's circuit and moving to the next RPC.

Two things arrived earlier than planned because leaving them out would have been misleading rather
than merely incomplete: the paid retry itself (T-002 cannot be green without it) and SPEC §6.7's
post-transmission asymmetry — release before the signature is sent, retain until TTL after. The
re-challenge loop, `maxPaidAttempts`, and full T-010/T-011/T-012 coverage remain M6's.

New fixtures: `tools/evm-rpc-stub` (deterministic local JSON-RPC with chain-spoofing, hang, and
error modes), three test-merchant scenarios, and seven `evm.authorization-plan` conformance vectors
that freeze the plan derivation and the `balanceOf` encoding for Python at S9.

### S6 — M4: TS Solana / SVM Adapter

- `SolanaSigner` → `@solana/kit` `TransactionSigner` adapter; `ExactSvmScheme` wiring.
- CAIP-2 alias resolution; genesis-hash cluster validation; ATA discovery + SPL balance;
  serialized-transaction size/account validation pre-signing.
- _Exit:_ Solana local validator + Devnet paid calls pass.

### S6 — M4 (delivered)

Landed the Solana counterpart to M3 without copying its two timing defects. `SolanaSigner` remains
the public, chain-library-free core contract; the optional adapter exposes its public key as an
`@solana/kit` `TransactionPartialSigner` and hands the caller exactly the compiled message bytes,
unsigned wire transaction, and SPEC §6.6 presentation. The adapter reads no clock until upstream
has produced the transaction it will constrain, and every RPC deadline is a promise race held in
tx402's own control flow rather than a composed or propagated `AbortSignal`.

Route planning derives the canonical SPL associated token account, proves the RPC's full genesis
hash before reading its parsed balance, and falls through across at most two manifest endpoints.
Immediately before payload creation it proves the exact endpoint again and hands that URL to
upstream's `ExactSvmScheme`. The signer boundary then decodes the versioned message and checks the
1232-byte wire limit, fee payer, blockhash, compute-budget programs, SPL Token program, source and
destination ATAs, mint, authority, integer amount, decimals, and memo before the external signer can
run. Token-2022 is rejected at planning even though upstream can construct it.

New fixtures: `tools/svm-rpc-stub` supplies a faithful `getGenesisHash`/`getAccountInfo`/
`getLatestBlockhash` harness with wrong-cluster, hang, and protocol failure modes; six local paid-call
tests cover T-003 and SEC-002; signer/RPC/plan contract suites cover malformed and oversized
transactions, invalid accounts, RPC failover, and signer output. Four indexed M4 vectors freeze
Devnet/Mainnet ATA derivation, lifetime clamping, the required facilitator fee payer, and Token-2022
exclusion for Python at S10.

The Devnet public-testnet leg is present as an opt-in suite using
`TX402_SOLANA_DEVNET_KEYPAIR`, but the variable is not funded/configured on this machine, so it is
reported skipped rather than green. O13 is resolved: OnFinality's independent keyless Devnet RPC
returned the canonical full genesis hash in a live probe and is now the signed manifest's secondary.

### S7 — M5: TS Routing + Health

- Deterministic RoutePlanner (SPEC §6.4 ordering, identical output for identical inputs).
- Concurrent balance fetch, 600 ms/provider, max 2 providers/network.
- HealthIndex: EWMA α=0.20, 20-observation window, open at 5 consecutive or ≥50 % of ≥10 samples,
  30 s open, 1 half-open probe, 128-entry LRU, 30 min idle retention.
- _Exit:_ T-004, T-005, T-008 (<150 ms p95 decision overhead), T-020 green.

### S7 — M5 (delivered)

Landed the RoutePlanner and the HealthIndex, and — the part that mattered more — **deleted** the
two circuits they replace. `EvmRpcPool` and `SvmRpcPool` no longer hold `openUntilEpochMs` or a
failure count; they ask one `HealthIndex` whether an endpoint may be used and report what happened.
That closes O19 and O22 structurally rather than by convention: there is no second place for the
state to live, so two layers cannot disagree about the same provider. `client.resetHealth()` is now
a single call that needs no adapter loaded or awaited.

`core/routing.ts` implements SPEC §6.4 as written. Every requirement becomes a candidate — including
one with no configured signer, which is a `no-signer-configured` candidate rather than a silent skip
— probes run together under `Promise.all`, and a `BalanceProbeCache` collapses requirements sharing a
network, asset, and owner onto one query (O20). **Every probe is awaited before anything is
ordered.** A "first viable candidate wins" shortcut would make the selection depend on which RPC
answered first, which is exactly what step 19 forbids; a test drives the preferred network to answer
last and asserts it still wins.

Ordering is a total key cascade: viability, then open-circuit, then policy preference, then buyer
fee, then health score, then observed latency, then requirement index. The open-circuit key is
deliberately above preference. SPEC §6.5 says an open endpoint "is ranked last", which is a stronger
statement than a low health score — a large enough preference bonus would outrank a score — so it
cannot be folded into step 17's number. A conformance vector pins exactly that case.

The HealthIndex is SPEC §6.5's table and nothing more: EWMA α=0.20 on both latency and success rate,
a 20-observation window, opening at five consecutive failures **or** ≥50 % of ≥10 samples, 30 s open,
one half-open probe, closing on one successful probe, 128-entry LRU, 30-minute idle retention. Two
details are worth recording. A successful probe **discards** the failure history that opened the
circuit, or a recovered endpoint would re-open on its next single failure. And `open()` exists
alongside the thresholds for chain-identity failures only: SPEC §7.1's `eth_chainId` mismatch and
§7.2's genesis mismatch are not reliability observations to average into a window, they say the
endpoint is serving another chain, and both clauses require moving on immediately.

Scores are rounded to four decimals with an explicit `floor(x * 10000 + 0.5) / 10000`. `Math.round`
and Python's `round` disagree at a half, and S10 has to reproduce these numbers exactly.

Six new vectors: four `routing.candidate-order` (preference over index, viability over preference,
open-circuit last, and a cascade where each remaining key decides exactly one pair) and two
`health.circuit`. The health expectations were derived from a reference implementation written
independently from the SPEC §6.5 table rather than read out of `src/core/health.ts`, and the
`failure-rate` vector opens a circuit at twelve samples with a consecutive count of two — reachable
only through the rate rule, so an implementation that collapsed the two thresholds into one would
pass the other vector and fail this one. That closes O15.

T-008 and T-020 are driven by a stub that accepts the connection and never answers — the observable
behaviour of total packet loss — behind the manifest's first Base RPC host, with the second healthy.
The decision-overhead figure is measured exactly as SPEC §12.3 defines it, from the moment the
complete 402 is handed back to tx402 to the moment before the signer is invoked, warmed. Warming is
the property under test here, not a convenience: sustained loss costs the primary's deadline five
times and then never again, because its circuit is open.

One test-harness defect is worth carrying forward, because it is the S5 lesson in a new place. The
first failover harness rebuilt the outbound RPC request as `new Request(input, init)` before
forwarding it, which dropped the pool's per-provider deadline signal, and the suite hung until it was
killed. Against a stub that never answers, a broken abort-follow chain is not a slow test — it is no
deadline at all. Test transports must forward `init` by identity.

### S8 — M6: TS Completion Semantics

- Paid retry: exactly one `PAYMENT-SIGNATURE`, `X-TX402-REQUEST-ID` (UUIDv7, disableable),
  caller `Idempotency-Key` preserved and never synthesized.
- `PAYMENT-RESPONSE` parsing → commit; re-challenge path with fresh nonce and `maxPaidAttempts`
  (default 2); `AmbiguousPaymentError` with reservation retained to TTL;
  `ResourceDeliveryError` with `paid=true`.
- _Exit:_ T-010, T-011, T-012 green. **TS reference implementation feature-complete; freeze
  conformance fixtures.**

### S9 — Python M1–M3

Transport (`httpx.BaseTransport` sync + async), protocol decode, policy, ledger, EVM adapter — all
validated against the S8-frozen fixtures. `Tx402Client`, `AsyncTx402Client`, `Policy`, `Tx402Error`.

### S10 — Python M4–M6

Solana adapter, routing + health, completion semantics.
_Exit:_ **T-016 — 100 % fixture parity** with TS on selected route, error code, normalized output.

### S11 — M7: CLI + Docs

- `npx tx402 call` with `--dry-run` (never invokes a signer), `--json`, `--max-spend`, `--network`,
  `--timeout`; exit codes 0/2/3/4/5/6/7/8/9 per SPEC §11. No private keys as flags.
- Generated API reference, hand-written security + operations guides, error reference, examples.
- _Exit:_ fresh-user time-to-value < 5 minutes without reading source (SPEC §16).

### S12 — M8: Hardening & Release

- Fuzz corpus (decoder, money, URL/domain, route determinism); perf gates (<15 ms p95 non-402,
  <150 ms p95 decision, <2 ms budget rejection, memory stability over 100 000 requests).
- SBOM, license report, vulnerability scan, reproducible build, npm + PyPI trusted publishing with
  provenance.
- Independent security review: parser, policy ordering, signer isolation, replay/ambiguity.
- Public testnet smoke suite passes **twice from clean environments** (T-019).
- _Exit:_ every SPEC §12.4 gate green → publish `tx402` 0.1.0 to npm and PyPI.

---

## 7. Status Board _(update every session)_

| Session | Milestone                | Status         | Notes                                                                                                                                                               |
| ------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1      | Bootstrap & Reserve      | ✅ Complete    | 2026-08-02. Workspace, ADR-001..010, both package scaffolds, size gate, CI. npm name reserved; PyPI blocked on O1.                                                  |
| S2      | M0 Spec fixtures         | ✅ Complete    | 2026-08-02. Names frozen. Schemas, signed manifest, 35 conformance vectors, error taxonomy, test merchant. ADR-011/012.                                             |
| S3      | M1 TS transport/protocol | ✅ Complete    | 2026-08-02. First request + inspect, strict v2 decode, replay safety, diagnostics; 36 vectors execute in both languages.                                            |
| S4      | M2 TS policy/ledger      | ✅ Complete    | 2026-08-03. Integer money, ordered policy, atomic TTL ledger, fingerprints; 42 vectors execute in both languages.                                                   |
| S5      | M3 TS Base adapter       | ✅ Complete    | 2026-08-03. EvmSigner + adapter, chain-ID verification, USDC balance, paid call. T-002 green; 49 vectors, TS runs M3. Three defects found via CI and fixed (O21).   |
| S6      | M4 TS Solana adapter     | ✅ Complete    | 2026-08-03. SolanaSigner→TransactionSigner, genesis/ATA balance, exact SPL USDC, pre-sign transaction validation. T-003 local green; Devnet live skipped for O2.    |
| S7      | M5 TS routing/health     | ✅ Complete    | 2026-08-03. Deterministic RoutePlanner, one shared HealthIndex subsuming both RPC circuits, concurrent deduped balances. T-004/T-005/T-008/T-020 green; 59 vectors. |
| S8      | M6 TS completion         | ⬜ Not started |                                                                                                                                                                     |
| S9      | Python M1–M3             | ⬜ Not started |                                                                                                                                                                     |
| S10     | Python M4–M6             | ⬜ Not started |                                                                                                                                                                     |
| S11     | M7 CLI + docs            | ⬜ Not started |                                                                                                                                                                     |
| S12     | M8 hardening + release   | ⬜ Not started |                                                                                                                                                                     |

Legend: ⬜ not started · 🟨 in progress · ✅ complete · 🟥 blocked

**Normative test status (SPEC §12.2):** T-001, T-002, T-003, T-004, T-005, T-006, T-007, T-008,
T-009, T-013, T-018, and T-020 are ✅ green. T-010…T-012 and T-014…T-017 and T-019 remain ⬜ because
their completion, Python-parity, or release milestones have not landed. T-011 and T-012 have partial S5 coverage — the
ambiguous-outcome and blocked-redirect behaviours are implemented and tested — but neither is
claimed until M6 exercises them through the full re-challenge loop. The test merchant now carries
scenarios for T-010, T-011, T-012, and T-017, plus refused-retry, corrupt-response, and
unsuccessful-settlement cases added at S5.

**Name reservation:** npm `tx402` ✅ `0.0.0` published 2026-08-02 (maintainer `jay.komarraju`,
Apache-2.0, `bin` resolves so `npx tx402` works) · PyPI `tx402` ✅ `0.0.0` published 2026-08-03
(Apache-2.0; wheel and source hashes verified; clean registry-install smoke passed). Runbook:
`docs/operations/publishing.md`. Both package names are reserved.

**Session 1 verification results (all green):**

| Check                          | Result                                                                      |
| ------------------------------ | --------------------------------------------------------------------------- |
| `pnpm lint`                    | clean, `--max-warnings 0`                                                   |
| `pnpm format:check`            | clean                                                                       |
| `pnpm typecheck`               | clean, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| `pnpm test`                    | 7 passed / 7                                                                |
| `pnpm build`                   | clean                                                                       |
| `pnpm size`                    | own code 0.30 KiB gz of a 25.00 KiB budget — PASS                           |
| `uv run ruff check .`          | clean                                                                       |
| `uv run ruff format --check .` | clean                                                                       |
| `uv run mypy`                  | clean, `strict`, 4 source files                                             |
| `uv run pytest -q`             | 9 passed / 9                                                                |
| `uv build`                     | sdist + wheel built                                                         |
| CLI smoke (both)               | `--version`, `--help` OK; unknown command exits 2 per SPEC §11              |

Note: the two size-gate numbers are currently identical only because the scaffold does not yet
import `@x402/core`. They diverge at M1, which is when the reported ceiling gets frozen (O4).

---

**Session 2 verification results (all green):**

| Check                          | Result                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| `pnpm lint`                    | clean, `--max-warnings 0`                                        |
| `pnpm format:check`            | clean                                                            |
| `pnpm typecheck`               | clean                                                            |
| `pnpm conformance:check`       | 35 vectors, index hashes match (M0: 24, M1: 11)                  |
| `pnpm manifest:verify`         | OK — signed by `tx402-release-1`, 4 networks, expires 2027-08-02 |
| `pnpm test`                    | 144 passed / 144                                                 |
| TS coverage (core modules)     | 99.37 % stmts, 97.57 % branch — gate 90 % **enforced**           |
| `pnpm build`                   | clean                                                            |
| `pnpm size`                    | own code 4.78 KiB gz of a 25.00 KiB budget — PASS                |
| `uv run ruff check .`          | clean                                                            |
| `uv run ruff format --check .` | clean                                                            |
| `uv run mypy`                  | clean, `strict`, 17 source files                                 |
| `uv run pytest -q`             | 132 passed / 132                                                 |
| Python coverage (core modules) | 98.41 % — gate 90 % **enforced** via pytest addopts              |

**CI is now genuinely verified.** `origin` (`github.com/jaykomarraju/tx402-dev`) was configured
before S2 but had never been pushed, so the workflow had never run. `main` was pushed at the end of
S2 and all seven jobs passed on the first run: TypeScript on Node 20 and 22, Python on CPython
3.10/3.11/3.12/3.13, and the TS↔Python conformance parity job. The workflow now also enforces
`conformance:check` (index integrity, SEC-007), `manifest:verify` (signature, SEC-007), and the
coverage thresholds.

Cross-language parity is real, not asserted: the release manifest is signed by the Node tool and
verified by the Python SDK, so tx402 canonical JSON and the Ed25519 envelope are proven identical
across the two implementations by the signature itself.

Conformance suite composition at S3: 24 M0 + 12 M1 vectors, **all 36 executing at Stage B in both
languages**. The twelfth M1 vector generates 65,537 decoded bytes from a compact recipe, so the
64 KiB SEC-006 boundary is exercised without committing an 87 KiB base64 blob.

---

**Session 3 verification results (all green):**

| Check                       | Result                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| `pnpm lint`                 | clean, `--max-warnings 0`                                                 |
| `pnpm format:check`         | clean                                                                     |
| `pnpm typecheck`            | clean                                                                     |
| `pnpm conformance:check`    | 36 vectors, index hashes match; all execute through M1 in both languages  |
| `pnpm manifest:verify`      | OK — signed by `tx402-release-1`, 4 networks, expires 2027-08-02          |
| `pnpm test`                 | 184 passed / 184                                                          |
| TS coverage (core modules)  | 97.83 % stmts / 93.46 % branch — 90 % gate enforced                       |
| `pnpm build`                | clean                                                                     |
| `pnpm size`                 | own 7.70 KiB / 25 KiB; total 22.30 KiB / frozen 24 KiB — both PASS        |
| `ruff check` / format check | clean                                                                     |
| `mypy`                      | clean, strict, 18 source files                                            |
| Python `pytest` + coverage  | 145 passed / 145; 97 % coverage — 90 % gate enforced                      |
| GitHub Actions CI #3        | 7 / 7 jobs green in 48 s; Node-action deprecation warnings tracked as O16 |

---

**Session 4 verification results (all green after the recorded size-gate amendment):**

| Check                        | Result                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| `pnpm lint` / format / types | clean; strict TypeScript remains green                                     |
| `pnpm conformance:check`     | 42 vectors, index hashes match; 24 M0 + 12 M1 + 6 M2 execute in both langs |
| `pnpm manifest:verify`       | signed manifest valid; 4 networks; expires 2027-08-02                      |
| TypeScript tests             | 221 passed / 221                                                           |
| TS coverage                  | 95.40 % statements / 91.87 % branch — 90 % gate enforced                   |
| Python lint / format / mypy  | clean; strict mypy over 20 source/test files                               |
| Python tests + coverage      | 157 passed / 157; 92.16 % branch-inclusive coverage                        |
| `pnpm build`                 | clean                                                                      |
| `pnpm size`                  | own 10.99 / 25 KiB; total 25.79 / amended 28 KiB — both PASS               |
| T-006 / T-007                | p95 local rejection <2 ms; signer/store untouched; concurrent cap atomic   |
| GitHub Actions CI #6         | 7 / 7 jobs green in 43 s; Node 20/22, Python 3.10–3.13, parity             |

Conformance suite composition at S4: 24 M0 + 12 M1 + 6 M2 vectors, **all 42 executing at Stage B
in both languages**. M2 adds three request-fingerprint goldens and three ledger transition vectors.

---

**Session 5 verification results (all green):**

| Check                        | Result                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| `pnpm lint` / format / types | clean; strict TypeScript remains green                                   |
| `pnpm conformance:check`     | 49 vectors, index hashes match; 24 M0 + 12 M1 + 6 M2 + 7 M3              |
| `pnpm manifest:verify`       | signed manifest valid; 4 networks; expires 2027-08-02                    |
| TypeScript tests             | 302 passed / 302, 2 skipped (the opt-in Base Sepolia live suite)         |
| TS coverage                  | 96.20 % statements / 91.68 % branch — 90 % gate enforced                 |
| Python lint / format / mypy  | clean; strict mypy over 20 source/test files                             |
| Python tests + coverage      | 164 passed / 164; 92.16 % branch-inclusive coverage                      |
| `pnpm build`                 | clean                                                                    |
| `pnpm size`                  | own 13.69 / 25 KiB; total 28.40 / amended 30 KiB; `tx402/evm` 5.51 KiB   |
| T-002                        | one reservation, one signature, one paid retry; ledger order proven      |
| SEC-002                      | signer count 0 for every policy, plan, liquidity, and chain-ID rejection |
| GitHub Actions CI #14        | 7 / 7 jobs green on `998e9f9`; Node 20/22, Python 3.10–3.13, parity      |
| CI history this session      | #8, #11, #12 red then #13, #14 green — three defects found; see below    |

**A real defect the first CI run caught.** CI #8 failed only in the conformance-parity job while
both TypeScript matrix jobs passed on the same commit — the signature of a race rather than a
regression. It was one. `createAuthorization` computed the permitted `validBefore` window _before_
calling upstream's `createPaymentPayload`, which reads its own clock to stamp the message. Whenever
a second boundary fell between the two reads, the signed `validBefore` exceeded the bound by exactly
one second and the adapter rejected a valid authorization — rare, random, and a burnt reservation
each time. The window is now derived inside the signer adapter from a clock read _after_ the message
exists, which makes `validBefore <= now + lifetime` true by construction rather than by timing. A
fake-timer regression test pins the ordering.

Worth recording for two reasons. The failing assertion was the adapter's own plan-enforcement check
on upstream's output, so the defect was in the guard rather than in what it guards — the class of
bug that a guard's presence tends to hide. And the local race window is well under a millisecond, so
it survived nine clean local runs, a clean-clone reproduction, and a single-worker run; only a
contended CI runner widened it enough to hit.

**A second, worse defect the same signal exposed.** CI #11 then failed on a PLAN-only commit, which
ruled out the first fix being the whole story. The step timings gave it away without any log access:
green runs finished the TypeScript suite in 5 seconds, both failures took 17–18, and exactly one
test carried a 15-second budget — the one asserting that a hanging merchant yields
`AmbiguousPaymentError`.

Both SDK deadlines were built as `AbortSignal.any([callerSignal, AbortSignal.timeout(ms)])`. That
composition is not equivalent to a timeout: `AbortSignal.timeout` unrefs its timer and the composite
holds its sources **weakly**, so once the helper returned nothing strongly referenced the timeout
signal. Collected before it fired, the deadline never fired at all. A standalone probe against a
hanging server, forcing collection, measured it directly — the composed signal missed its deadline
**10 times out of 10**, an explicitly-held `AbortController` + `setTimeout` **0 out of 10**.

This one was a production defect, not a test problem: a paid retry to a merchant that accepts the
connection and never answers would hang the caller's `fetch` indefinitely instead of raising the
`AmbiguousPaymentError` SPEC §6.7 requires — silence in precisely the case where money may already
have moved. Deadlines are now built from an `AbortController` and a `setTimeout` whose handles are
held by a disposer the request path keeps alive and clears when the attempt settles.

The regression tests deliberately do **not** force garbage collection. Driving `global.gc()` on an
interval inside a vitest worker starves undici badly enough that even a caller's own
`AbortController` stops taking effect — the instrument breaks what it measures, so a proof built on
it would prove nothing. `test/deadline.test.ts` asserts the behaviour that must hold regardless: the
deadline fires, a caller's abort is still honoured when a deadline is layered over it, and no
deadline is imposed when none is configured.

**And that was still not all of it — the third defect was the real one.** CI #12, on the deadline fix
itself, failed with the same 17-second signature. What finally cracked it was giving up on the full
suite and running only the two files that could plausibly hang together: `test/deadline.test.ts` and
`test/evm-payment.test.ts` reproduce the failure locally about **one run in eight**, with
`client.fetch` never settling.

Holding the timer strongly was necessary but not sufficient. `new Request(input)` does **not** share
`input`'s signal — it creates a new one that _follows_ it through a `WeakRef` to the intermediate
controller. The request path builds several Requests in sequence: add the signature header, set
`redirect: "manual"`, and then whatever a caller's transport wrapper does. If any intermediate
Request is collected, the follow chain breaks silently from that link onward, and the abort never
reaches the socket. The earlier probe missed it precisely because it had only one Request.

The deadline is therefore no longer entrusted to signal propagation at all. It rejects a promise
tx402 races against the fetch itself, in its own control flow, where nothing can collect it. The
signal still travels down — it is what tears the socket down — but as a courtesy, not as the
mechanism. `issuePaidRetry` also stopped rebuilding a Request that is already `redirect: "manual"`,
removing one more weak hop from the real path.

Evidence: **100 consecutive clean runs** of the pair that had failed at iteration 3. At the observed
one-in-eight rate, 100 clean runs is a chance outcome with probability under 10⁻⁵. CI #13 and #14
are green, but the local count is the real evidence — a single green CI run never was.

**The lesson worth carrying into M4.** All three defects were in the same layer — code tx402 wrote
to _guard_ something — and each was invisible to a green local suite. A signal-based timeout, a
composed abort, and a pre-computed clock window all look correct and all fail only under conditions
a fast machine does not produce. The Solana adapter at S6 will want a per-provider deadline and a
transaction expiry window of its own; both should be built on the same racing primitive rather than
on `AbortSignal` composition, and neither should read a clock before the value it will be compared
against exists.

**Process note for the next session.** Two of this session's plan edits asserted a CI result before
the run reported, and one of them was wrong for several minutes. A verification table must only ever
record a run that has actually completed. Write the row after the result, never in anticipation of
it.

Conformance suite composition at S5: 24 M0 + 12 M1 + 6 M2 + 7 M3. **The TypeScript runner executes
all 49 at Stage B; Python executes 42 and validates the other seven at Stage A**, which is the
two-stage contract working as designed — Python's `IMPLEMENTED_THROUGH` stays at `M2` until S9.

Coverage now includes `src/evm/**` and `src/signers/**` alongside `src/core/**`. The adapter holds
security-critical assertions (SEC-001, SPEC §6.6/§7.1), so exempting it from the SPEC §12.1
threshold would have exempted exactly the code that most needs the coverage.

---

**Session 6 verification results (all local gates green; public Devnet wallet unavailable):**

| Check                        | Result                                                                      |
| ---------------------------- | --------------------------------------------------------------------------- |
| `pnpm lint` / format / types | clean; strict TypeScript remains green                                      |
| `pnpm conformance:check`     | 53 vectors; 24 M0 + 12 M1 + 6 M2 + 7 M3 + 4 M4                              |
| `pnpm manifest:verify`       | signed manifest valid; Devnet now has two independently operated RPC URLs   |
| TypeScript tests             | 341 passed / 341, 3 skipped (Base Sepolia + Solana Devnet opt-in live legs) |
| TS coverage                  | 93.96 % statements / 90.14 % branch — 90 % gate enforced                    |
| Python lint / format / mypy  | clean; strict mypy over 20 source/test files                                |
| Python tests + coverage      | 168 passed / 168; 92.16 % branch-inclusive coverage                         |
| `pnpm build`                 | clean                                                                       |
| `pnpm size`                  | own 13.95 / 25 KiB; total 28.58 / 30 KiB; `tx402/solana` 5.91 KiB           |
| T-003 / SEC-002              | one reservation before one SVM signer call; one paid retry; one commit      |
| Solana Devnet live           | skipped — `TX402_SOLANA_DEVNET_KEYPAIR` unavailable (O2)                    |

Conformance suite composition at S6: 24 M0 + 12 M1 + 6 M2 + 7 M3 + 4 M4. **The TypeScript runner
executes all 53 at Stage B; Python executes 42 and validates the other eleven at Stage A**, which is
the intended two-stage contract. Coverage now includes `src/solana/**`; the transaction validator
and RPC cluster boundary are held to the same global 90 % gate as core and EVM.

**S6 CI is verified green.** Commit `8159b6b` was pushed to `main`; GitHub Actions run
[#16](https://github.com/jaykomarraju/tx402-dev/actions/runs/30792957631) completed 7/7 successfully:
TypeScript on Node 20 and 22, Python on CPython 3.10/3.11/3.12/3.13, and TS↔Python conformance
parity. The run also passed frozen-lockfile install, lint, format, typecheck, conformance-index,
manifest-signature, coverage, build, and size gates.

---

**Session 7 verification results (all local gates green):**

| Check                        | Result                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `pnpm lint` / format / types | clean; strict TypeScript remains green                                       |
| `pnpm conformance:check`     | 59 vectors; 24 M0 + 12 M1 + 6 M2 + 7 M3 + 4 M4 + 6 M5                        |
| `pnpm manifest:verify`       | signed manifest valid; 4 networks; expires 2027-08-02 (362 days)             |
| TypeScript tests             | 394 passed / 394, 3 skipped (Base Sepolia + Solana Devnet opt-in live legs)  |
| TS coverage                  | 93.95 % statements / 90.40 % branch — 90 % gate enforced                     |
| Python lint / format / mypy  | clean; strict mypy over 20 source files                                      |
| Python tests + coverage      | 174 passed / 174; 92.16 % branch-inclusive coverage                          |
| `pnpm build`                 | clean                                                                        |
| `pnpm size`                  | own 15.89 / 25 KiB; total 30.58 / re-baselined 32 KiB; adapters 6.42 / 6.90  |
| T-004 / T-005                | Base and Solana both offered; preference and viability each decide correctly |
| T-008                        | secondary used on a dark primary; warmed decision p95 well under 150 ms      |
| T-020                        | 8/8 paid calls funded through the backup; primary contacted 5 times total    |

`pnpm size` failed at first: the total core-path figure reached 30.55 KiB against the 30 KiB M3
ceiling. This is the re-baseline the ADR-008 M3 amendment explicitly anticipated for M5 and it was
applied under the policy that amendment states — an **M5 amendment** recording the measurement, the
milestone, and what was added, moving the tracking ceiling to 32 KiB. No dependency was added, no
chain adapter entered the core path, and the blocking own-code gate stayed at 25 KiB with 9.12 KiB
of headroom. One re-baseline remains anticipated, at M6.

Conformance suite composition at S7: 24 M0 + 12 M1 + 6 M2 + 7 M3 + 4 M4 + 6 M5. **The TypeScript
runner executes all 59 at Stage B; Python executes 42 and validates the other seventeen at
Stage A** — the two-stage contract working as designed, with Python's `IMPLEMENTED_THROUGH` still at
`M2` until S9. Two new vector kinds were added to the frozen schema: `routing.candidate-order` and
`health.circuit`.

## 8. Session Protocol (how this stays a living document)

**At the start of every session,** the agent MUST:

1. Read `PLAN.md`, then `SPEC.md` (authoritative) and `PRD.md` (intent).
2. Read the §7 status board and the §9 open-items log to find the current position.
3. Confirm the working tree is clean and CI is green before writing new code.

**At the end of every session,** the agent MUST, in this order:

1. Run the full test suite and record actual results — including failures, verbatim.
2. Update §7 status board (session status, test IDs now green, reservation status).
3. Append to §9 open items / risk log: anything discovered, deferred, or blocked.
4. Record any SPEC deviation as a new ADR in `adr/` and reference it in §2.
5. Commit `PLAN.md` together with the session's code, message
   `chore(plan): session <N> — <milestone> <status>`.
6. **Emit the handoff prompt** (§8.1) as the final message of the session, filled in with real
   values, in a copy-paste code block.

### 8.1 Handoff prompt template

> The agent fills every `<...>` with concrete values and emits this verbatim at session end.

```
Continue tx402 development in /Users/jayanthkomarraju/Documents/GitHub/tx402-dev.

Read these first, in order:
  1. PLAN.md   — living plan, status board in §7, open items in §9
  2. SPEC.md   — authoritative implementation spec (governs; PRD never overrides it)
  3. PRD.md    — product intent only
  4. adr/      — all ADRs, especially ADR-008/009/010 (deviations from SPEC)

Where we are:
  Last completed session: S<N> — <milestone name>
  Status: <what actually landed, in one or two sentences>
  Tests green: <T-00X, T-00Y, ...>
  Tests failing / not yet written: <list, or "none">
  Last commit: <sha> "<message>"
  CI: <green | red — reason>

Your session: S<N+1> — <milestone name>
Goal: <one sentence>
Deliverables:
  - <item>
  - <item>
Exit criteria: <specific tests / gates that must be green>

Open items you must handle or explicitly re-defer:
  - <from PLAN.md §9>

Blocked / needs the user:
  - <e.g. PyPI API token, testnet wallet funding — or "nothing">

Constraints (non-negotiable):
  - SPEC.md governs. Changing any MUST/MUST NOT requires a new ADR in adr/.
  - Package name is `tx402`, unscoped, on both npm and PyPI. No @tx402 scope.
  - Money is always integer atomic units. Never JS number / Python float.
  - Policy evaluation and budget reservation happen BEFORE any signer call (SEC-002).
  - Never log or embed signatures, keys, or authorization payloads (SEC-003).
  - The buyer SDK never calls facilitator /verify or /settle (ADR-002).

Finish by following PLAN.md §8: update the status board, log open items, commit PLAN.md
with the code, and emit the next handoff prompt.
```

---

## 9. Open Items & Risk Log _(append-only; never delete, mark resolved)_

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Owner            | Status                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | -------------------------------------------- |
| O1  | **Resolved 2026-08-03.** Published the inert `tx402==0.0.0` placeholder wheel and source distribution to PyPI. The public JSON record reports the intended name, version, Apache-2.0 license, and Python `>=3.10`; both SHA-256 hashes match the locally verified artifacts, and a clean `uvx` registry-install smoke returned `tx402 0.0.0`. Step-by-step and hashes are in `docs/operations/publishing.md`.                                                                                                                                                                                                                                                                                                            | Agent            | ✅ Resolved S6                               |
| O2  | Testnet wallets must be funded for Base Sepolia + Solana Devnet. Keep balances low and dedicated. **Unblocked for both M3 and M4 automated suites:** Base uses the local EVM RPC stub; Solana uses the faithful SVM fixture harness, so T-002/T-003 are green without credentials. The opt-in Solana suite reads `TX402_SOLANA_DEVNET_KEYPAIR` as a 64-byte JSON array and was skipped at S6 because it is unavailable. Funded wallets remain required for the SPEC §12.1 public-testnet legs and T-019 at S12. Base runbook: `docs/operations/base-testnet.md`.                                                                                                                                                         | **User**         | 🟥 Open, no longer blocking; due by S12      |
| O3  | Public GitHub org/repo for the open-source migration. Keep repo URLs behind one constant until decided.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **User**         | 🟨 Deferred                                  |
| O4  | Informational size ceiling. **Resolved at S3, amended at S4 and again at S5.** M1 froze 24 KiB, M2 amended to 28 KiB, and M3's payment path made the total 28.39 KiB, so ADR-008 now sets 30 KiB — and states the re-baseline as a policy rather than repeating it as an exception: the blocking own-code gate stays at 25 KiB and never moves, the total is a tracking number re-baselined only by an ADR amendment recording the measurement, and it freezes for good at M8. S5 also corrected the measurement itself: the lazy `import()` targets in `core/chain.ts` are now external, so adapter bytes stop being reported as core bytes. Actual M3 own code is 13.69 KiB.                                           | Agent            | ✅ Resolved S5 (policy stated)               |
| O5  | `routing.maxQuoteAgeMs` is inert for standard v2 challenges (no upstream timestamp). **Resolved at S4:** PolicyEngine checks RFC3339 `extra.timestamp` only when present, after rolling-budget evaluation; stale, invalid, and >15 s future metadata are covered. Standard v2 remains a documented no-op.                                                                                                                                                                                                                                                                                                                                                                                                                | Agent            | ✅ Resolved S4                               |
| O6  | Upstream `@x402/*` is on a fast release cadence. Every bump replays all conformance fixtures per SPEC §15. **Re-verified at S6 because the optional Solana peer surface changed, with no version bump:** installed `@x402/svm` remains 2.20.0 and `@solana/kit` resolves to 5.5.1. `ExactSvmScheme` still obtains mint metadata through `@solana-program/token` 0.9.0 / token-2022 0.6.1, derives canonical ATAs, creates a versioned transaction, and invokes a `TransactionSigner`; tx402 now directly declares the same 0.9.0 SPL parser/PDA dependency as an optional peer so its pre-sign validator does not rely on transitive resolution. The M3 EVM findings remain unchanged. Recheck at every dependency bump. | Agent            | ⬜ Ongoing                                   |
| O7  | SPEC §12.1 asks for Windows CI "where supported". **Resolved at S1:** Linux-only for now. Nothing platform-sensitive exists yet — no filesystem paths, no shell-outs, no native bindings. macOS and Windows legs are added at S12 (M8) before release, when the CLI and file-based `--body @file` handling actually exist.                                                                                                                                                                                                                                                                                                                                                                                               | Agent            | ✅ Resolved S1                               |
| O8  | Independent security review (SPEC §12.4) needs a reviewer lined up well before S12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **User**         | 🟨 Deferred                                  |
| O9  | npm's 72-hour unpublish window on `tx402@0.0.0` closes **2026-08-05**. After that the version number is permanent and cannot be reused. No action needed — `0.0.0` is intended to stay burned — but any change of heart about the placeholder must happen before then.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Agent            | ⬜ Informational                             |
| O10 | `publishConfig.provenance: true` is set on the npm package, but the S1 placeholder was published from a laptop with `--no-provenance` (provenance needs CI OIDC). The release workflow must **not** carry that flag, and trusted publishing must be configured on both registries before `0.1.0`.                                                                                                                                                                                                                                                                                                                                                                                                                        | Agent            | ⬜ Pending S12                               |
| O11 | Test coverage thresholds. **Resolved at S2, two sessions early.** 90 % line/branch/function/statement is enforced in `packages/tx402/vitest.config.ts` and in the Python `[tool.coverage.report] fail_under`. Actual: TS 99.37 % stmts / 97.57 % branch, Python 98.41 %. `src/tx402/cli.py` is omitted until M7 (S11).                                                                                                                                                                                                                                                                                                                                                                                                   | Agent            | ✅ Resolved S2                               |
| O12 | The release manifest signing key `tx402-release-1` was generated locally at S2. The private half is gitignored at `core-spec/manifests/keys/tx402-release-1.private.pem` and **exists only on this machine — back it up.** Before `0.1.0` a release key must be generated in a secure environment and held in CI OIDC or a secret manager (SPEC §13); the dev key must not sign a published release. Runbook: `docs/operations/release-manifest.md`.                                                                                                                                                                                                                                                                     | **User** / Agent | 🟥 Open, backup needed now; rotation due S12 |
| O13 | Solana RPC redundancy. **Resolved at S6.** Mainnet already had the independent keyless `https://rpc.solanatracker.io/public`. A live `getGenesisHash` probe against OnFinality's keyless `https://solana-devnet.api.onfinality.io/public` returned Devnet's canonical `EtWTR...PkrZBG` full hash, so it is now the signed manifest's second Devnet RPC. The SVM pool caps use at two providers, proves genesis on each, fails over on deadline, mismatch, malformed ATA, and transport/protocol failure, and never exposes URL paths or queries in diagnostics. Full HealthIndex scoring remains M5 rather than part of this item.                                                                                       | Agent            | ✅ Resolved S6                               |
| O14 | The bundled manifest expires **2027-08-02**. After that no client can be constructed until it is re-issued. `manifest:verify` warns below 90 days remaining. Re-issue is a patch release (SPEC §15).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Agent            | ⬜ Informational, due 2027-05                |
| O15 | Conformance gaps left at M0. **Resolved at S7.** The remaining route-candidate and ordering vectors are indexed: four `routing.candidate-order` and two `health.circuit`, taking the suite to 59. The health expectations were derived from a reference implementation written independently from the SPEC §6.5 table rather than read out of the SDK, and the `failure-rate` vector opens a circuit through the rate rule alone — twelve samples, consecutive count two — so an implementation that collapsed the two thresholds into one cannot pass both vectors.                                                                                                                                                     | Agent            | ✅ Resolved S7                               |
| O16 | GitHub Actions' deprecated Node 20 action runtime. **Resolved at S4 and verified in CI #6:** CI now uses official `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`, and immutable `astral-sh/setup-uv@v9.0.0`, all on the Node 24 action runtime. setup-uv's prior cache pruning is explicit. The application matrix still tests Node 20 and 22.                                                                                                                                                                                                                                                                                                                                                   | Agent            | ✅ Resolved S4                               |
| O17 | The S4 handoff asked to read root `SECURITY.md` and `CONTRIBUTING.md`, but neither file exists anywhere in the repository. No S4 implementation guidance was lost: SPEC §9 and the ADRs remain authoritative. Add both public-repository documents with the M7 documentation pass, before open-source migration.                                                                                                                                                                                                                                                                                                                                                                                                         | Agent            | 🟨 Deferred S11                              |
| O18 | M6 work partially landed at S5 because T-002 could not be green without a paid retry, and a half-implemented retry would have been misleading about money. What exists now: one signature, one attempt, commit on delivery, release on any pre-transmission failure or definitive merchant refusal, and `AmbiguousPaymentError` with the reservation retained on anything ambiguous after transmission. What M6 still owes: the re-challenge loop with `maxPaidAttempts` (a repeated 402 is currently reported, not retried), fresh-challenge parsing on the second attempt, and T-010/T-011/T-012 claimed under that loop.                                                                                              | Agent            | 🟨 Scope note, due S8                        |
| O19 | **Resolved at S7 by deletion, not by layering.** `EvmRpcPool` no longer has `openUntilEpochMs` or `consecutiveFailures`; it asks the client's single `HealthIndex` whether an endpoint may be used and reports the outcome with a latency. `CIRCUIT_OPEN_MS` in `core/chain.ts` is now a re-export of `HEALTH_OPEN_MS`, so the 30-second figure exists once. There is no second place for circuit state to live, which makes the "two circuits disagree" failure mode unreachable rather than merely untested.                                                                                                                                                                                                           | Agent            | ✅ Resolved S7                               |
| O20 | **Resolved at S7.** `planRoutes` runs every probe under one `Promise.all`, and a `BalanceProbeCache` memoizes on the in-flight promise keyed by network, asset, and owner, so requirements sharing all three join one query instead of racing two. The two-provider cap stays where it was, in each pool's constructor. A unit test asserts peak concurrency of three probes against two distinct reads, and T-008's warmed decision p95 is well inside the 150 ms gate.                                                                                                                                                                                                                                                 | Agent            | ✅ Resolved S7                               |
| O21 | **Resolved at S5.** S5's three intermittent CI failures were three production defects in guard code: an EVM authorization clock-boundary race, a weakly held composed timeout signal, and a broken abort-follow chain across successive `Request` objects. Deadlines are now enforced by promise races in tx402 control flow, and authorization bounds are computed only after the values they constrain exist. Runs #13, #14, and #15 were all 7/7 green and the failing pair ran clean locally 100 consecutive times. The workflow's failure-annotation diagnostic is deliberately retained; read it before changing code on any future red run. S6 follows both rules in the Solana RPC and signer adapter.           | Agent            | ✅ Resolved S5                               |
| O22 | **Resolved at S7 alongside O19.** `SvmRpcPool` lost its own `openUntilEpochMs` and reports into the same `HealthIndex` as the EVM pool, namespaced `<caip2>\|<host>` so a provider serving several chains is scored per chain. A genesis-hash mismatch still opens immediately, via `HealthIndex.open`, which is reserved for the SPEC §7.1/§7.2 chain-identity rules — those are not reliability samples to average into a window, and both clauses require moving to the next RPC now.                                                                                                                                                                                                                                 | Agent            | ✅ Resolved S7                               |
| O23 | The PyPI upload token supplied for the one-time reservation was exposed in conversation. Revoke it immediately in PyPI account settings, then use a project-scoped `tx402` token only if needed before OIDC trusted publishing is configured. Do not store the replacement in chat, the repository, shell profiles, or `.pypirc`. Real releases remain CI-only under O10.                                                                                                                                                                                                                                                                                                                                                | **User**         | 🟥 Open — revoke credential now              |
| O24 | A test transport that rebuilds an outbound request as `new Request(input, init)` **drops the per-provider deadline signal**, because a rebuilt Request only _follows_ the original's signal through a WeakRef. S7's first failover harness did exactly that and the suite hung until it was killed — against a stub that never answers, a broken follow chain is not a slow test, it is no deadline at all. This is S5's `withDeadline` lesson reappearing in test code. Shims must forward `init` by identity; worth a shared test helper at S12.                                                                                                                                                                       | Agent            | 🟨 Convention, revisit S12                   |

---

## 10. Verification

**Per session:** `pnpm test` (TS) and `pytest` (Python) must be green, plus the specific SPEC §12.2
test IDs named in that session's exit criteria. Report real results — a failing test is reported as
failing, with output.

**End-to-end, the release-defining check (SPEC §16):** from a clean environment, install `tx402`,
follow the documented example, and complete a **real paid call on Base Sepolia and on Solana Devnet
in under 5 minutes without reading source code.** Then:

```bash
# TypeScript
npm i tx402
npx tx402 call <testnet-merchant-url> --max-spend "0.10 USDC" --dry-run   # no signer invoked
npx tx402 call <testnet-merchant-url> --max-spend "0.10 USDC" --json      # real paid call

# Python
uv pip install tx402
python examples/python/quickstart.py
```

**Release gates (SPEC §12.4), all blocking:** P0/P1 tests green on protected `main`; no unresolved
critical/high security finding; 100 % TS↔Python conformance parity; SBOM + license + provenance +
reproducible build; testnet smoke suite passing twice from clean environments; docs published;
independent security review clear.
