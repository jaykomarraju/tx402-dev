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

**Current state:** _(updated end of S10)_ **both SDKs are feature-complete for v0.1 and are at
behavioral parity.** The TypeScript reference finished at S8; Python caught up across S9 and S10
and now owns the same request path end to end — sync and async HTTPX transports, strict v2 decode,
integer-only policy, an atomic rolling ledger, the Base and Solana adapters, deterministic routing
over one shared `HealthIndex`, and SPEC §6.7's completion semantics. **T-016 is green:** both
runners execute all 65 frozen vectors at Stage B with `IMPLEMENTED_THROUGH = "M6"`, so normalized
output, route ordering, error codes, and the money rule are proven identical by the same files
rather than asserted. The fixture set stays frozen (O27). What remains for 0.1.0 is the CLI and
docs (S11) and release hardening (S12).

**The blockers are cleared and the testnet legs are live.** _(S11)_ Both wallets are funded,
dedicated, and verified from the chain rather than from a claim — Base Sepolia holds 0.01 ETH and
20 USDC, Solana Devnet 5.00125 SOL and 30 USDC, each on the mint the signed manifest names (O2) —
and **both opt-in live suites were run and passed**, so the public-testnet path is exercised code
rather than aspiration. The public repository is decided (`neogeeks/tx402`, O3) and the URL
constants point at it, while `origin` stays on `jaykomarraju/tx402-dev` until the S12 migration.
The manifest signing key is backed up and the manifest still verifies (O12, backup half only —
rotation into CI OIDC remains a release blocker), and the exposed PyPI token is revoked with no
replacement, because S12 configures trusted publishing instead (O23). Nothing external now gates
S11.

**Sources of truth, in precedence order:**

1. `SPEC.md` — governs all v0.1 implementation behavior (its §0 says so explicitly).
2. `PRD.md` — product intent; explains _why_, never overrides _what_.
3. This plan — sequencing and process only. It never overrides SPEC behavior; where it deviates from
   SPEC, an ADR is required and is listed in §3.

**Development happens in `tx402-dev`.** The public open-source repo is a later migration; keep all
metadata (repo URLs, badges) behind a single constant so the move is a one-file change.

---

## 2. Locked Decisions (from this planning session)

| #   | Decision                                                                                                                                                                                                          | Consequence                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Package name is `tx402`, unscoped, on both npm and PyPI.** No `@tx402` org.                                                                                                                                     | Every `@tx402/sdk` reference in SPEC.md §4.1, §13, §16 reads `tx402`. Requires **ADR-009**.                                                                                                                                                                                                                                |
| D2  | **One npm package `tx402`** exposing the SDK at `.` and the CLI via a `bin` entry.                                                                                                                                | `npx tx402 call ...` works with zero extra install. Merges SPEC §3.1's separate `/packages/cli`. Covered by **ADR-009**. CLI code lives outside the core import path so it does not count against the size gate.                                                                                                           |
| D3  | **Reserve both names by publishing a `0.0.0` placeholder.** npm immediately (already authed as `jay.komarraju`); PyPI as soon as an API token exists.                                                             | npm has no true reservation — publishing is the only hold. Placeholder is public; npm unpublish is only possible within 72h.                                                                                                                                                                                               |
| D4  | **Bundle-size gate re-baselined.** Blocking gate: tx402's **own emitted code** < 25 KiB gzipped. Informational: total core-path footprint incl. `@x402/core` + zod, ceiling frozen from a real measurement at M1. | SPEC §12.3's literal "<25 KiB core import path" is unreachable — measured `@x402/core` ESM at ~27 KiB gzipped alone, plus zod ~13 KiB. Requires **ADR-008**.                                                                                                                                                               |
| D5  | **TypeScript first through M6, then Python catches up against frozen conformance fixtures.**                                                                                                                      | Matches SPEC ADR-005 (TS is the reference implementation). Python inherits a settled design instead of tracking churn.                                                                                                                                                                                                     |
| D6  | **`retryable` is derived from a six-value `retryability` classification; per-error data lives in `details`, not in the closed `Tx402ErrorContext`.**                                                              | SPEC §8's Retryable column has six values while §4.2 names one boolean. Requires **ADR-011**. Only `TransportError` reports `retryable: true`.                                                                                                                                                                             |
| D7  | **Manifests are signed over domain-separated tx402 canonical JSON; trusted keys are compiled into each package.**                                                                                                 | SPEC §5.4 defines the signature member but not the bytes it covers. Requires **ADR-012**. Adds `cryptography` to the Python core install — CPython has no Ed25519 and SPEC §3.2 forbids writing one.                                                                                                                       |
| D8  | **ADR-008's total-core size ceiling is 28 KiB from the measured M2 baseline; the independent 25 KiB own-code limit is unchanged.**                                                                                | M2's policy/ledger are necessarily reachable from `createTx402Client`. Measured 25.79 KiB total / 10.99 KiB own; explicit ADR-008 amendment, no dependency change. **Superseded by D9.**                                                                                                                                   |
| D9  | **Chain adapters are reached through a lazy `import()` from the core path, and the total-core ceiling becomes a tracking number re-baselined by ADR amendment (30 KiB at M3).**                                   | Keeps SPEC §4.1's `signers: { evm, solana }` config exactly as written while `@x402/evm` and `viem` stay off the size-gated core path. Amends **ADR-008**; the blocking own-code gate stays at 25 KiB and never moves.                                                                                                     |
| D10 | **The circuit breaker exists exactly once, in `core/health.ts`.** RPC pools hold endpoint lists and failure classification; they hold no circuit state.                                                           | Closes O19 and O22 structurally. `EvmRpcPool` and `SvmRpcPool` consult and report into the client's single `HealthIndex`, and `CIRCUIT_OPEN_MS` re-exports `HEALTH_OPEN_MS`. No ADR needed — SPEC §6.5 describes one health index; M3/M4's per-pool circuits were the deviation, and this removes them.                    |
| D11 | **The Python SDK compiles the SVM transaction itself; TypeScript still delegates to `@x402/svm`.**                                                                                                                | PyPI `x402`'s `ExactSvmScheme` requires a raw `Keypair` (violating SEC-001 and SPEC §7.2) and cannot be imported against `solana` 0.40. Requires **ADR-013**. The wire bytes, instruction layout, and signature slots are reproduced exactly, and the frozen vectors plus T-016 hold the two languages to the same output. |

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

A second defect was caught after the first commit, by reading the diff rather than by a test.
Two **raw NUL bytes** had landed in `src/evm/adapter.ts` and two more in `src/solana/adapter.ts` —
the separator in the balance-cache key was written as a literal `\x00` instead of the escape
`\u0000`. The resulting strings were correct and every gate passed, but git classifies a file
containing a NUL as binary: `git diff` reported `Bin 9713 -> 10761 bytes` and `grep` silently
refused to search it. A source file that cannot be diffed cannot be reviewed. The separator is now
`BALANCE_KEY_SEPARATOR` in `core/routing.ts`, declared once as an escape, and both adapters build
their key with `join`. A repository-wide scan confirms no tracked source or fixture file contains a
NUL byte.

### S8 — M6: TS Completion Semantics

- Paid retry: exactly one `PAYMENT-SIGNATURE`, `X-TX402-REQUEST-ID` (UUIDv7, disableable),
  caller `Idempotency-Key` preserved and never synthesized.
- `PAYMENT-RESPONSE` parsing → commit; re-challenge path with fresh nonce and `maxPaidAttempts`
  (default 2); `AmbiguousPaymentError` with reservation retained to TTL;
  `ResourceDeliveryError` with `paid=true`.
- _Exit:_ T-010, T-011, T-012 green. **TS reference implementation feature-complete; freeze
  conformance fixtures.**

### S8 — M6 (delivered)

Landed the re-challenge loop, and with it the last of the v0.1 TypeScript surface. The part
worth recording is not the loop but where its rules live. SPEC §6.7's five clauses are now one
pure function, `core/completion.ts`'s `classifyPaidAttempt`, which takes an attempt number, the
configured bound, and how the one signature-bearing request ended, and returns what must happen
to the reservation. `client.ts` looks the disposition up and obeys it; there is no branch in the
request path that can drift from the specification on its own, and S10 inherits the table through
six `completion.paid-attempt` vectors rather than re-deriving it from prose.

`maxPaidAttempts` is enforced **inside** the 402 branch of that table, not as a loop guard. The
distinction is the whole reason exhaustion is a typed terminal error: with `maxPaidAttempts: 1`
there is no second pass for a guard to prevent, so an implementation that decided exhaustion by
falling out of a loop would have nowhere to raise the error and would report the bare 402 instead.
A vector pins exactly that case. Exhaustion raises `ResourceDeliveryError` with
`reason: "max-paid-attempts-exhausted"`, `paid: false`, and both `attempt` and `maxPaidAttempts`
in `details` — no new error code, because the SPEC §8 taxonomy is frozen at fifteen and this is a
resource the merchant would not deliver.

Every attempt re-runs the whole pipeline: policy, plan, reserve, sign. Nothing carries over. The
merchant fixture now supports `rechallengeRequirements`, so the T-010 test re-prices the offer
between attempts — and the merchant's own retry validator rejects an `accepted` amount it never
offered, which means an implementation that reused the first normalized challenge fails the test
rather than passing it quietly. Signature freshness is proven two ways: distinct EIP-712 nonces
captured at the signer boundary, and distinct SHA-256 digests of the raw `PAYMENT-SIGNATURE`
header recorded by the merchant. The header value itself is still never retained (SEC-003) — a
digest answers "were these two different?" without keeping anything sensitive.

An ambiguous outcome **ends** the loop rather than consuming an attempt. A 5xx, a timeout, and a
blocked cross-origin redirect all leave the reservation held to its TTL, and with three attempts
configured only one is used. Retrying there is precisely what SPEC §6.7 forbids without an
idempotency strategy, and tx402 has none to offer because merchant semantics are unknown.

**One money defect was found while writing the table, and it predates this session.** A
same-origin redirect on a paid retry was reaching the `!response.ok` branch and being treated as
a definitive refusal — reservation released, `paid: false`. But a 3xx is not a refusal. The
merchant may well have settled and be redirecting to the delivered resource, and releasing there
hands back budget for money that moved. It is now `ambiguous` with
`causeCategory: "redirect-not-followed"`, and a vector puts a 403, a `success: false` settlement,
and a 307 side by side so the three cannot be collapsed back into one non-2xx branch. Following
same-origin redirects, which SPEC §6.1 does allow, is **not** implemented and is recorded as O26.

### S9 — Python M1–M3

Complete 2026-08-03. Python now owns synchronous and asynchronous HTTPX transports and the M1–M3
request path: replay-safe body capture, reserved-header and URL enforcement, strict v2 decode,
integer-only policy arithmetic in SPEC §6.3 order, an `RLock`-atomic 120-second reservation ledger,
and the Base exact adapter. `EvmRpcPool` proves `eth_chainId` on the same endpoint before its
`balanceOf` read, tx402 races both RPC and paid-retry deadlines in its own control flow, and the
signer boundary validates the complete EIP-712 authorization before delegating to PyPI `x402`
2.17.*. Policy evaluation and reservation precede every signer call.

`Tx402Client`, `AsyncTx402Client`, `Tx402Transport`, `AsyncTx402Transport`, `PolicyEngine`,
`MemorySpendStore`, and `EvmSigner` are public. The Python runner advances to M3 and executes all
49 M0–M3 vectors at Stage B. No fixture or normative specification changed.

### S10 — Python M4–M6

Solana adapter, routing + health, completion semantics.
_Exit:_ **T-016 — 100 % fixture parity** with TS on selected route, error code, normalized output.

### S10 — Python M4–M6 (delivered)

Complete 2026-08-03. Python now executes **all 65 frozen vectors at Stage B**, matching
TypeScript exactly, and `IMPLEMENTED_THROUGH` is `M6` in both runners. No fixture, schema, or
index file changed.

The parts worth recording are the two places where "port it" was the wrong answer.

**The Solana adapter could not delegate to upstream, and an ADR says why.** PyPI `x402`'s
`ExactSvmScheme` reads `signer.keypair` and calls `keypair.sign_message(...)` — its signer
contract _is_ a raw Ed25519 key pair, which SEC-001 forbids the core from requiring and SPEC
§7.2's "without exporting secret material" forbids outright. There is no shim that satisfies
both, because a KMS or hardware wallet has no keypair object to hand over. Independently, the
module cannot even be imported: it does `from solana.rpc.api import Client`, and `solana` 0.40
removed that module. So Python compiles the transfer itself from `solders` primitives, and
**ADR-013** records the decision, the byte-level layout it must reproduce, and the constraint
that no primitive is re-implemented — base58, Ed25519, SHA-256, and PDA derivation all come
from the same audited library upstream builds on. TypeScript still delegates to `@x402/svm`;
the divergence is in _how_ the transaction is produced, never in _what_ is produced, and the
frozen vectors plus T-016 are what hold that line.

`_validate_transaction` decodes the **serialized** message rather than inspecting the builder's
own objects. That is the whole point: a validator that reads the builder's output agrees with a
construction bug instead of catching it. Six parameterized mutations drive a transaction that
left the plan past the builder and assert the signer is never reached.

**Four S9 client tests were wrong, and the frozen M6 vectors are what proved it.** S9's
approximation reported `causeCategory: "merchant-server-error"` where the vectors say
`"server-error"`, treated a paid 402 as a definitive refusal rather than a re-challenge, and
split a paid-retry timeout out as `"timeout"` while TypeScript reports
`transport-after-signature` for it. That last one is the interesting one: a deadline and a reset
are the same fact about settlement, so both now reach the disposition table as one input and
share its category. Per O27 the diagnosis came before any edit, and in all four cases the defect
was in Python, not in the fixture — the tests were updated and the fixtures were not touched.

Two structural fixes came with the port. `EvmRpcPool` no longer carries a private failover
loop: like the new `SvmRpcPool`, it asks the client's single `HealthIndex` whether an endpoint
may be used and reports the outcome, so Python has the same one-circuit property S7 gave
TypeScript by deletion (O19/O22). And `tx402/__init__.py` deliberately does **not** re-export
anything from `tx402.solana`: that module imports `solders`, so re-exporting it would make every
core install depend on a chain library, and the failure would land as an `ImportError` on
`import tx402` for a user who installed exactly what the README told them to. A subprocess-based
package-contract test now asserts that importing `tx402` loads no chain library at all.

Deadlines moved to `tx402/deadline.py` so both RPC pools and both transports share one
primitive. Nothing about the rule changed: the work is _raced_, cancellation is requested but
never trusted, and the timeout is enforced by tx402 returning control to its caller (O24).

### S11 — M7: CLI + Docs

- `npx tx402 call` with `--dry-run` (never invokes a signer), `--json`, `--max-spend`, `--network`,
  `--timeout`; exit codes 0/2/3/4/5/6/7/8/9 per SPEC §11. No private keys as flags.
- Generated API reference, hand-written security + operations guides, error reference, examples.
- _Exit:_ fresh-user time-to-value < 5 minutes without reading source (SPEC §16).

### S12 — M7 completion + M8 hardening (delivered in part)

Complete 2026-08-04 for everything except the release mechanics. O34 was diagnosed rather than
patched, and the diagnosis inverted the open item: both fixes S11 proposed would have changed
frozen contract surface without fixing the flake, because the health score above the latency key
is itself latency-derived. The defect was the test's premise, and `order_route_candidates` is
unchanged in both languages.

The Python CLI reaches full SPEC §11 parity with the TypeScript one — same flags, same `--json`
document, and an exit-code table held to TypeScript's row for row by a test, because a script's
`if [ $? -eq 3 ]` is a public API in both languages. `client.plan()` gained its Python
counterpart at the same seam, so `--dry-run` predicts the shipped decision path rather than a
second implementation of it, and `cli.py` left the coverage exemption in the same change.

Documentation is an **MDX site** (Astro Starlight, 16 pages), and two of its pages are generated
from the built package's own exports rather than written: the error reference cannot claim an
exit code the binary does not return, and `pnpm docs:check` fails CI if the taxonomy changes
without a regenerate. ADR-014 settles O26. `SECURITY.md` and `CONTRIBUTING.md` close O17.

Time to value was measured against a **genuinely settled** Base Sepolia payment by wiring the
test merchant's `/verify` and `/settle` to the public x402 facilitator — ADR-002 keeps both on
the merchant, so the buyer SDK still never learns a facilitator exists. **1.66 s**, with the
receipt read back from a public RPC rather than taken from the facilitator's reply.

What remains for release: trusted publishing (O10), the manifest key rotation half of O12, the
T-019 Solana leg (O35), and a CI run.

### S14 — M8: Release engineering

- Root `README.md` (there is none — it is the first thing anyone sees), `CHANGELOG.md`,
  `CODE_OF_CONDUCT.md`, and a stated versioning policy.
- O40 remainder: `tools/ttv` takes a network argument; record a Solana TTV number.
- O35: a Devnet RPC endpoint with adequate quota, so T-019's Solana leg can complete.
- O10 trusted publishing, O12 release key rotation.
- The `tools/test-merchant` defect found at S13: a failed settlement answers 402 with no
  `PAYMENT-REQUIRED` header, so the buyer reports `missing-header` rather than the cause.

### S15 / S16 / S17 — the release gates

Charters are **§11**, which is normative for sequencing. In short: an audit that distrusts
the existing tests, then a cold-start UX pass that reads only what a user reads, then — and
only then — publishing is planned. All three stages before the last happen on `tx402-dev`;
nothing touches `neogeeks/tx402` until the first two run clean.

### S12 remaining — M8: Release

- Fuzz corpus (decoder, money, URL/domain, route determinism); perf gates (<15 ms p95 non-402,
  <150 ms p95 decision, <2 ms budget rejection, memory stability over 100 000 requests).
- SBOM, license report, vulnerability scan, reproducible build, npm + PyPI trusted publishing with
  provenance.
- Independent security review: parser, policy ordering, signer isolation, replay/ambiguity.
- Public testnet smoke suite passes **twice from clean environments** (T-019).
- _Exit:_ every SPEC §12.4 gate green → publish `tx402` 0.1.0 to npm and PyPI.

---

## 7. Status Board _(update every session)_

| Session | Milestone                | Status         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1      | Bootstrap & Reserve      | ✅ Complete    | 2026-08-02. Workspace, ADR-001..010, both package scaffolds, size gate, CI. npm name reserved; PyPI blocked on O1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| S2      | M0 Spec fixtures         | ✅ Complete    | 2026-08-02. Names frozen. Schemas, signed manifest, 35 conformance vectors, error taxonomy, test merchant. ADR-011/012.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| S3      | M1 TS transport/protocol | ✅ Complete    | 2026-08-02. First request + inspect, strict v2 decode, replay safety, diagnostics; 36 vectors execute in both languages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| S4      | M2 TS policy/ledger      | ✅ Complete    | 2026-08-03. Integer money, ordered policy, atomic TTL ledger, fingerprints; 42 vectors execute in both languages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| S5      | M3 TS Base adapter       | ✅ Complete    | 2026-08-03. EvmSigner + adapter, chain-ID verification, USDC balance, paid call. T-002 green; 49 vectors, TS runs M3. Three defects found via CI and fixed (O21).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| S6      | M4 TS Solana adapter     | ✅ Complete    | 2026-08-03. SolanaSigner→TransactionSigner, genesis/ATA balance, exact SPL USDC, pre-sign transaction validation. T-003 local green; Devnet live skipped for O2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| S7      | M5 TS routing/health     | ✅ Complete    | 2026-08-03. Deterministic RoutePlanner, one shared HealthIndex subsuming both RPC circuits, concurrent deduped balances. T-004/T-005/T-008/T-020 green; 59 vectors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| S8      | M6 TS completion         | ✅ Complete    | 2026-08-03. Re-challenge loop under `maxPaidAttempts` over one pure SPEC §6.7 disposition table. T-010/T-011/T-012 green; 65 vectors, fixtures frozen. TS feature-complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| S9      | Python M1–M3             | ✅ Complete    | 2026-08-03. Sync/async HTTPX transports, strict protocol, integer policy, atomic ledger, and Base adapter. Python executes all 49 M0–M3 vectors at Stage B.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| S10     | Python M4–M6             | ✅ Complete    | 2026-08-03. Solana adapter (ADR-013), deterministic routing over one shared HealthIndex, and SPEC §6.7 completion. **T-016 green: both languages run all 65 at Stage B.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S11     | M7 CLI + docs            | ✅ Complete    | 2026-08-04. **Landed:** Step 0 verification of every S11 unblocker (O2/O3/O12-backup/O23, plus O32/O33 recorded); URL constants repointed to `neogeeks/tx402` with a four-file parity pin; Python structured redacting diagnostics, closing the last behavioural gap between the SDKs; **T-015 green in both languages**; and the full SPEC §11 TypeScript CLI including `client.plan()` for `--dry-run`. A real Base Sepolia paid call runs through the built binary in 452 ms. **Not done, carried to S12:** Python CLI and its coverage gate, the O26 redirect ADR, docs/examples/SECURITY.md/CONTRIBUTING.md (O17), the settled-through-a-real-facilitator TTV measurement, and CI. **New blocker found: O34**, an intermittent route-ordering flake that only appears under coverage. **Closed at S12**, which delivered the carried items. |
| S12     | M8 hardening + release   | 🟨 In progress | 2026-08-04. **O34 diagnosed and closed** — both fixes the item proposed would have changed frozen contract surface _without fixing the flake_; the defect was the test's premise. **Python CLI** at full SPEC §11 parity with `client.plan()`, and `cli.py` inside the 90 % gate. **ADR-014** decides O26. **Docs are an MDX site** (Astro Starlight, 16 pages) with a generated error reference; `SECURITY.md` + `CONTRIBUTING.md` close O17. **NUL guard** (O25) and macOS/Windows CI legs (O7). **TTV measured against a real settled Base Sepolia payment: 1.66 s**, verified on-chain. **T-019 Base leg 50/50 green; Solana leg blocked on public Devnet RPC quota (O35).** Remaining for release: O10 trusted publishing, O12 key rotation, and a CI run.                                                                                  |

| S14 | M8 release engineering | ⬜ Not started | Fuzz corpus, perf gates, SBOM/licence/vulnerability scan, reproducible build, trusted publishing (O10), release key rotation (O12), the O40 TTV remainder and O35's keyed Devnet RPC. Also the missing release-facing documents: root `README.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, and a stated versioning policy. |
| S15 | Pre-publication audit | ⬜ Not started | **§11.2.** On `tx402-dev`. Correctness, adversarially derived tests, security, maintainer quality. Governing rule: the existing tests are not proof. No publish planning. |
| S16 | Fresh-eyes UX pass | ⬜ Not started | **§11.3.** On `tx402-dev`, **cold start** — reads the README and docs site only, never `PLAN.md`, until the pass is done. Installs and uses the product as a stranger; times TTV with a stopwatch. |
| S17 | Publish | ⬜ Not started | **§11.4.** Planned only once S15 and S16 run clean. `neogeeks/tx402` migration, npm + PyPI trusted publishing, SPEC §12.4 gates. |

Legend: ⬜ not started · 🟨 in progress · ✅ complete · 🟥 blocked

**Normative test status (SPEC §12.2):** T-001 through T-014 and T-016 through T-018 and T-020 are
✅ green. **T-019 is half claimed at S12:** the suite exists
(`packages/tx402/test/volume.live.test.ts`) and its Base Sepolia leg delivers 50/50 with fifty
distinct signature digests and no degradation, but the Solana Devnet leg stops at 8 because the
manifest's free keyless endpoints exhaust their per-IP quota — an environment limit, diagnosed
and recorded as O35, not an SDK defect. It stays ⬜ until a Devnet endpoint with adequate quota
is available. **T-016 is claimed at S10:** both runners execute all 65 frozen vectors at Stage B with
`IMPLEMENTED_THROUGH = "M6"`, so normalized output, selected route ordering, error codes, and the
SPEC §6.7 disposition table are proven identical across the two languages by the same fixtures.
T-003, T-004, T-005, T-010, T-011, T-012, and T-020 now also run through Python's real client and
transport boundaries, not only TypeScript's. **T-015 is claimed at S11 in both languages:** Python
gained the structured redacting logger it was missing, and both suites seed a real secret into
every input the request path touches — signing key, bearer token, query credential, body,
settlement id — then search the whole serialised event stream for each one, on the success path
and on the policy-rejection path. TypeScript signs with a real key against the validating test
merchant, so the signature is checked in hex, base64 and base64url as it actually went on the
wire. **T-019 remains ⬜** and is M8/S12 (O2 is now resolved, so it is no longer blocked). The
test merchant carries scenarios for every claimed test plus `rechallenge-malformed` (added at S8),
refused-retry, corrupt-response, and unsuccessful-settlement.

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

**S7 CI is verified green on the M5 commit.** `e01841c` was pushed to `main`; GitHub Actions run
[#19](https://github.com/jaykomarraju/tx402-dev/actions/runs/30869395611) completed 7/7 successfully:
TypeScript on Node 20 and 22, Python on CPython 3.10/3.11/3.12/3.13, and TS↔Python conformance
parity. The run also passed frozen-lockfile install, lint, format, typecheck, conformance-index,
manifest-signature, coverage, build, and the re-baselined size gate.

Two follow-up commits are also verified 7/7 green: `25abb21`, the NUL-byte fix recorded as O25, is
[run #20](https://github.com/jaykomarraju/tx402-dev/actions/runs/30869582982), and `99f3715`, which
moves the separator declaration above the interface it documents and exports it, is
[run #21](https://github.com/jaykomarraju/tx402-dev/actions/runs/30869715349). Every row in the S7
table above was written after the run it describes had reported, per the S5 process note.

---

**Session 8 verification results (all local gates green):**

| Check                        | Result                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `pnpm lint` / format / types | clean; strict TypeScript remains green                                         |
| `pnpm conformance:check`     | 65 vectors; 24 M0 + 12 M1 + 6 M2 + 7 M3 + 4 M4 + 6 M5 + 6 M6                   |
| `pnpm manifest:verify`       | signed manifest valid; 4 networks; expires 2027-08-02 (362 days)               |
| TypeScript tests             | 419 passed / 419, 3 skipped (Base Sepolia + Solana Devnet opt-in live legs)    |
| TS coverage                  | 94.09 % statements / 90.61 % branch — 90 % gate enforced                       |
| Python lint / format / mypy  | clean; strict mypy over 20 source files                                        |
| Python tests + coverage      | 180 passed / 180; 92.16 % branch-inclusive coverage                            |
| `pnpm build`                 | clean                                                                          |
| `pnpm size`                  | own 16.34 / 25 KiB; total 31.03 / 32 KiB — **no M6 re-baseline needed**        |
| T-010                        | re-priced re-challenge paid on attempt 2; distinct nonces and signature hashes |
| T-011                        | 5xx and hang both retain the reservation and end the loop at one attempt       |
| T-012                        | cross-origin redirect blocked; reservation retained; no further attempt spent  |

`core/completion.ts` is at 100 % statement and branch coverage, which matters more than the
aggregate here: it is the whole of SPEC §6.7's money rule in one file, and every one of its
branches is reached by both a vector and an integration test.

The M6 size re-baseline PLAN anticipated did **not** happen. M6 added one small pure module and
no dependency; the total core path came to 31.03 KiB against the 32 KiB ceiling S7 set, and the
blocking own-code gate has 8.66 KiB of headroom. ADR-008's ceiling now freezes for good at M8.

Conformance suite composition at S8: 24 M0 + 12 M1 + 6 M2 + 7 M3 + 4 M4 + 6 M5 + 6 M6.
**The TypeScript runner executes all 65 at Stage B; Python executes 42 and validates the other
twenty-three at Stage A** — the two-stage contract working as designed, with Python's
`IMPLEMENTED_THROUGH` still at `M2` until S9. One new vector kind was added to the frozen schema:
`completion.paid-attempt`. `core-spec/conformance/README.md` now carries the freeze declaration
and what changing a frozen vector costs.

**S8 CI is verified green on the M6 commit.** `b87a5a3` was pushed to `main`; GitHub Actions run
[#23](https://github.com/jaykomarraju/tx402-dev/actions/runs/30870956827) completed 7/7
successfully: TypeScript on Node 20 and 22, Python on CPython 3.10/3.11/3.12/3.13, and TS↔Python
conformance parity. The run also passed frozen-lockfile install, lint, format, typecheck,
conformance-index, manifest-signature, coverage, build, and size gates. This row was written after
the run reported, per the S5 process note.

---

**Session 9 verification results (all local gates green):**

| Check                        | Result                                                                      |
| ---------------------------- | --------------------------------------------------------------------------- |
| `pnpm lint` / format / types | clean; strict TypeScript remains green                                      |
| `pnpm conformance:check`     | frozen 65-vector index unchanged                                            |
| `pnpm manifest:verify`       | signed manifest valid; 4 networks; expires 2027-08-02 (362 days)            |
| TypeScript tests             | 419 passed / 419, 3 skipped (Base Sepolia + Solana Devnet opt-in live legs) |
| TS coverage                  | 94.09 % statements / 90.61 % branch — 90 % gate enforced                    |
| Python lint / format / mypy  | clean; strict mypy over 27 source/test files                                |
| Python tests + coverage      | 269 passed / 269; 93.27 % branch-inclusive coverage                         |
| Python package               | lock check clean; source distribution and wheel build clean                 |
| `pnpm build`                 | clean                                                                       |
| `pnpm size`                  | own 16.34 / 25 KiB; total 31.03 / 32 KiB — unchanged                        |
| T-002 / SEC-002              | policy + reservation precede one EVM signer call; one paid retry            |
| T-007                        | concurrent reservations enforce the atomic rolling-hour cap                 |
| T-014 / T-017                | invalid manifest fails construction; initial merchant failure stays typed   |

Conformance suite composition remains 24 M0 + 12 M1 + 6 M2 + 7 M3 + 4 M4 + 6 M5 + 6 M6.
**Python now executes all 49 M0–M3 vectors at Stage B and validates the remaining sixteen at
Stage A.** TypeScript still executes all 65 at Stage B. The S8 fixture freeze was respected: no
fixture, schema, or conformance index file changed.

PyPI `x402` is now constrained to `>=2.17,<2.18`, matching the 2.17.0 API inspected and exercised
by the adapter while npm remains on `@x402/core` 2.20.0. Their v2 envelope fields agree at the
tx402 boundary: Python's upstream scheme receives the normalized accepted requirement and returns
the same `PaymentPayload` shape the frozen M3 plan and client tests require. O6 remains ongoing for
every future dependency move.

S9 explicitly re-defers the external or later-milestone work: O2 testnet wallets and O10 trusted
publishing remain due S12; O12 still needs the user's backup; O17 and O26 remain due S11; O21's CI
failure annotations are preserved; O24's request/deadline forwarding rule was followed; O25's NUL
guard remains due S12; and O27 remains the governing fixture rule.

**S9 CI is verified green.** Commit `7927c2e` was pushed to `main`; GitHub Actions run
[#25](https://github.com/jaykomarraju/tx402-dev/actions/runs/30873126010) completed 7/7
successfully: TypeScript on Node 20 and 22, Python on CPython 3.10/3.11/3.12/3.13, and TS↔Python
conformance parity. The run also passed frozen-lockfile install, lint, format, typecheck,
conformance-index, manifest-signature, coverage, package builds, and size gates. This result was
written only after the workflow completed.

---

**Session 10 verification results (all local gates green):**

| Check                        | Result                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm lint` / format / types | clean; strict TypeScript remains green                                              |
| `pnpm conformance:check`     | frozen 65-vector index unchanged — 24 M0 + 12 M1 + 6 M2 + 7 M3 + 4 M4 + 6 M5 + 6 M6 |
| `pnpm manifest:verify`       | signed manifest valid; 4 networks; expires 2027-08-02 (362 days)                    |
| TypeScript tests             | 419 passed / 419, 3 skipped (Base Sepolia + Solana Devnet opt-in live legs)         |
| TS coverage                  | 94.09 % statements / 90.60 % branch — 90 % gate enforced                            |
| Python lint / format / mypy  | clean; strict mypy over 37 source/test files                                        |
| Python tests + coverage      | 393 passed / 393; 92.93 % branch-inclusive coverage                                 |
| Python package               | `uv lock --check` clean; sdist and wheel build clean                                |
| `pnpm build`                 | clean                                                                               |
| `pnpm size`                  | own 16.34 / 25 KiB; total 31.03 / 32 KiB — unchanged, no Python effect              |
| **T-016**                    | **65 / 65 vectors at Stage B in both languages; 12 kinds, no missing handler**      |
| T-003 / SEC-002              | one reservation before one SVM signer call; one paid retry; one commit              |
| T-004 / T-005                | preference wins when both are viable; viability outranks preference                 |
| T-010                        | re-priced re-challenge paid on attempt 2; distinct nonces and header digests        |
| T-011 / T-012                | 5xx, same-origin 3xx, and a blocked cross-origin redirect all retain the TTL        |
| T-020                        | dark primary RPC contacted 5 times, then never again — its circuit is open          |
| NUL-byte scan (O25)          | 227 tracked files scanned, none contains a NUL; every changed file diffs            |

Conformance suite composition is unchanged at 24 M0 + 12 M1 + 6 M2 + 7 M3 + 4 M4 + 6 M5 + 6 M6.
**Both runners now execute all 65 at Stage B**, which is what closes the two-stage contract that
has been open since S3: there are no Stage-A-only vectors left in either language. The S8 fixture
freeze was respected — `git status core-spec/` is clean, and `pnpm conformance:check` re-verifies
every per-file SHA-256 against the index.

One new ADR: **ADR-013**, recording why Python compiles the SVM transaction itself rather than
delegating to PyPI `x402`'s `ExactSvmScheme`, and what that decision is bounded by. It narrows
SPEC §7.2 for Python only and weakens no MUST — it is what makes SEC-001 and §7.2's
"without exporting secret material" simultaneously satisfiable in this language.

`solders` is now a directly declared dependency of the `tx402[svm]` extra (`>=0.27,<1`) rather
than a transitive one, for the same reason S6 declared `@solana-program/token` directly on the
TypeScript side: tx402's own pre-sign validator depends on it, so it must not rely on another
package's resolution. It stays off the core install path, and a subprocess-based package-contract
test asserts that `import tx402` loads no chain library at all.

**S10 CI is verified green.** Commit `0d64e9b` was pushed to `main`; GitHub Actions run
[#27](https://github.com/jaykomarraju/tx402-dev/actions/runs/30875614118) completed 7/7
successfully: TypeScript on Node 20 and 22, Python on CPython 3.10/3.11/3.12/3.13, and TS↔Python
conformance parity. The run also passed frozen-lockfile install, lint, format, typecheck,
conformance-index, manifest-signature, coverage, package builds, and size gates. The 3.10 leg
matters more than usual this session: it resolves `solders` 0.27.1 rather than the 0.28.0 this
machine develops against, so the SVM construction path is confirmed against both. This row was
written only after the workflow completed, per the S5 process note.

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

**Commit authorship (standing rule, from S11).** Commits carry **no `Co-Authored-By: Claude …`
trailer**, and no other agent-attribution trailer either. The user pushes under their own account
only, and the repository's git identity — `Jayanth Komarraju <jay.komarraju@gmail.com>` — is
already correct. A future session must not reintroduce the trailer, including when a tool or
default template suggests it.

**Pushing (standing rule, from S11; scope corrected at S13).** Never commit, push, or
otherwise touch the public `neogeeks/tx402` repository without the user's explicit,
in-session approval. `origin` remains `jaykomarraju/tx402-dev`, and **the migration is not
planned until the §11.2 audit and the §11.3 UX pass have both run clean** — the S11 note
called it "the S12 migration", which is superseded. Pushing to `origin` for CI is ordinary
work and needs no approval. 6. **Emit the handoff prompt** (§8.1) as the final message of the session, filled in with real
values, in a copy-paste code block.

### 8.1 Handoff prompt template

> The agent fills every `<...>` with concrete values and emits this verbatim at session end.

```
Continue tx402 development in /Users/jayanthkomarraju/Documents/GitHub/tx402-dev.

Read these first, in order:
  1. PLAN.md   — living plan, status board in §7, open items in §9
  2. SPEC.md   — authoritative implementation spec (governs; PRD never overrides it)
  3. PRD.md    — product intent only
  4. adr/      — all ADRs, especially ADR-008/009/010/013 (deviations from SPEC)

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

**Session 12 verification results (all local gates green; one live leg blocked on an external quota):**

| Check                               | Result                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `pnpm lint` / format / types        | clean; strict TypeScript remains green                                 |
| `pnpm nul-check`                    | **new (O25)** — 281 tracked files, no NUL bytes                        |
| `pnpm conformance:check`            | 65 vectors, index hashes match — **unchanged**                         |
| `pnpm manifest:verify`              | signed manifest valid; 4 networks; expires 2027-08-02                  |
| TypeScript tests                    | 463 passed / 11 skipped (opt-in live legs, now including T-019)        |
| TS coverage                         | 94.18 % statements / 90.53 % branch — 90 % gate enforced               |
| Python lint / format / mypy         | clean; strict mypy over 42 source/test files                           |
| Python tests + coverage             | 468 passed; **92.18 % with `cli.py` inside the gate**                  |
| `pnpm build` / `pnpm size`          | own 16.56 / 25 KiB; total 31.25 / 32 KiB — both PASS                   |
| `pnpm docs:check`                   | **new** — both generated pages current                                 |
| `pnpm docs:build`                   | 16 MDX pages built (Astro Starlight, Node 22)                          |
| **TTV against a real settled call** | **1.66 s** against a 300 s budget — see below                          |
| T-019 Base Sepolia                  | **50/50 delivered**, 50 distinct signatures, mean 154 ms / p95 221 ms  |
| T-019 Solana Devnet                 | **8/50 — blocked on public Devnet RPC quota (O35), not an SDK defect** |
| GitHub Actions CI                   | **not yet run** — nothing pushed this session                          |

**CI took three runs, and all three failures were real.** Run #29 completed as a _failure with
zero jobs_ — an invalid job-level context (`env` in a job `name`) rejects the whole workflow
before any job exists, and log download needs auth the agent does not have, so there was
nothing to read. Run #30 created its ten jobs and failed three: lint on both Node legs,
because `examples/typescript` consumes `tx402` through its emitted declarations and CI lints
_before_ building — it passed locally only because `dist/` was already there; the docs site,
because `pnpm format` had reflowed JSX inside a list item and mangled an MDX comment _after_
the successful build was observed, and `docs:check` only compares the two generated pages; and
Windows, because git's default `core.autocrlf` rewrites LF to CRLF and tx402 hashes files over
their bytes, invalidating all 65 vector hashes. Run #31 is 10/10 green. Each fix carries a
guard so the failure cannot recur silently: `tools/workflow-lint`, build-before-lint,
`pnpm docs:build` in `pnpm check`, and `.gitattributes`. **The macOS/Windows legs added this
session found a real bug on their first run**, which is the argument for having added them.

**O34 was not what the open item said it was, and the measurement is why.** S11 recorded two
candidate fixes — quantise `observedLatencyMs` into buckets, or demote it below requirement
index — and flagged both as frozen-vector contract changes needing O27/O29 handling. Before
touching a fixture, the ordering keys were instrumented across eight runs of the failing
scenario. The result rules out both fixes: `health_score` is **itself** latency-derived and
varies at its own four-decimal resolution (0.8398 against 0.8397 between runs), so it decides
some passes and the raw latency decides others. Coarsening or demoting the key _below_ the
score leaves the key _above_ it exactly as noisy. Both proposed fixes would therefore have
changed contract surface in both languages and left the flake in place.

The actual defect was the test's premise. SPEC §6.4 step 19 conditions determinism on
"identical inputs **and health state**", and both measured keys are fresh wall-clock readings
of the balance probe — five fresh clients are five different health states. The TypeScript
counterpart of the same test never flaked because it pins `preferNetworks` and so never
reaches the measured keys; Python's was the outlier. `order_route_candidates` is unchanged in
both languages. The end-to-end test now holds every key above the measured ones fixed, and
step 19's real content — a pure function, and an exact tie falling through to requirement
index — is asserted directly in both suites. **12/12 clean runs under coverage**, against
roughly one failure in four before.

**The TTV number is against a genuinely settled payment.** The public demo merchant at
`x402.org/protected` is down (502), but the facilitator at `https://x402.org/facilitator` is
up, keyless, and supports `exact / eip155:84532` at x402Version 2. `tools/test-merchant` gained
a `facilitatorUrl` option, so the local merchant now performs a real `/verify` and `/settle`
and reports the on-chain transaction in `PAYMENT-RESPONSE`. ADR-002 keeps both calls on the
merchant, so the buyer SDK still never learns a facilitator exists — which is exactly what
makes a local merchant a legitimate fixture here: the buyer's code path is the shipped one and
the fixture supplies only the counterparty.

Two runs settled. The recorded one is
[`0xe902cfa9…c30bc78`](https://sepolia.basescan.org/tx/0xe902cfa9a7c93535b3940d16af3f3d6a3e09a9ecb3f6d3518eee77aa7c30bc78),
verified by reading the receipt from `https://sepolia.base.org` rather than by trusting the
facilitator's reply: status `0x1`, block 45028561, on the manifest's USDC contract
`0x036CbD…dCF7e`, one ERC-20 `Transfer` of **1000 atomic units from
`0xaad1566216D2447B530E04945dfEefD04C84967B` to a distinct recipient**, plus the EIP-3009
`AuthorizationUsed` event that burns the nonce. The first run paid the payer's own address;
the recipient was changed precisely so the receipt answers "did value leave the wallet",
which a self-transfer would have left open. **Total 1.66 s: 278 ms to confirm facilitator
capability, 365 ms for the dry run, 989 ms for the settled call.**

**T-019's Solana leg is blocked by an external quota, and the diagnosis matters.** The Base
leg is clean: 50/50 delivered, 50 distinct `PAYMENT-SIGNATURE` digests, no untyped exception,
no degradation across the run. The Solana leg delivers exactly **8** and then fails every
remaining call with a typed `TX402_TRANSPORT`. The first reading was rate limiting, and pacing
was added — but 600 ms and 2 000 ms spacing produce the _same_ cutoff at exactly 8, which
rules a rate out. Instrumenting the RPC traffic showed why: each Solana payment costs **five**
Devnet RPC requests (2 × `getGenesisHash`, 2 × `getAccountInfo`, 1 × `getLatestBlockhash`),
and both manifest endpoints begin returning 429 after roughly forty requests from one IP —
`api.devnet.solana.com` first, then `solana-devnet.api.onfinality.io` on failover. tx402 then
does the right thing: fails over, opens both circuits, and refuses to sign. **Zero SDK-caused
signature failures and zero unhandled exceptions, which is what SPEC §12.2 actually asks of
T-019** — but the leg cannot complete fifty calls against free keyless endpoints, so it is
recorded as O35 rather than claimed. The assertions were deliberately **not** weakened to make
it pass.

One thing seen once and not yet explained: call 9 surfaced as `TX402_SIGNER` rather than
`TX402_TRANSPORT` while calls 10+ were transport. A 429 arriving during authorization creation
may be classified as a signer failure rather than an RPC one. It is recorded in O35 and needs
its own look; it is a diagnosis-quality issue, not a money-safety one.

**Two strict-mypy failures in `tests/test_diagnostics.py` predate this session.** They were
present on the clean S11 tree — confirmed by stashing every S12 change and re-running with a
fresh cache — so S11's "mypy clean" row was recorded against a stale cache. Both were unused
`type: ignore` comments; both are fixed here. Worth carrying forward as a process note: a
verification row for a cached tool should be written after a cache-cold run.

---

## 9. Open Items & Risk Log _(append-only; never delete, mark resolved)_

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Owner            | Status                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------- |
| O1  | **Resolved 2026-08-03.** Published the inert `tx402==0.0.0` placeholder wheel and source distribution to PyPI. The public JSON record reports the intended name, version, Apache-2.0 license, and Python `>=3.10`; both SHA-256 hashes match the locally verified artifacts, and a clean `uvx` registry-install smoke returned `tx402 0.0.0`. Step-by-step and hashes are in `docs/operations/publishing.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Agent            | ✅ Resolved S6                                     |
| O2  | **Resolved S11.** Both testnet wallets are funded, dedicated, and low-balance per SPEC §13, and were verified at S11 by deriving each address from the local key and reading a public RPC. Base Sepolia `0xaad1566216D2447B530E04945dfEefD04C84967B` holds **0.010000 ETH** and **20.000000 USDC** on the manifest contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, with the RPC confirming chain 84532. Solana Devnet `9VyoFEDVasUjrfugJ6xd2fGwXjfAuHLBBxVGgZ8wnqqm` holds **5.001250000 SOL** and **30 USDC** on the manifest mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (ATA `C4mQsdu6iAx6y1pWuoFfV69165WgwgXWoQoj9nQs9cox`), and the cluster's genesis hash matches the manifest network ID. **Both opt-in live suites were actually executed and passed** — `base-sepolia.live.test.ts` 2/2, `solana-devnet.live.test.ts` 1/1. T-019's volume legs remain S12. See O33 for the environment-variable trap found while doing this. Base runbook: `docs/operations/base-testnet.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **User** / Agent | ✅ Resolved S11                                    |
| O3  | **Resolved S11.** The public org/repo is **`https://github.com/neogeeks/tx402`**, with GitHub Private Vulnerability Reporting enabled — that is the security contact for `SECURITY.md`, so no separate disclosure email is needed. The URL constants are repointed at S11 in all four places that carry them (`packages/tx402/src/meta.ts`, `packages/tx402-python/src/tx402/meta.py`, `packages/tx402-python/pyproject.toml`, `packages/tx402/package.json`), and a cross-language parity test pins them so the two SDKs cannot drift. **`origin` deliberately still points at `jaykomarraju/tx402-dev`** — the migration of the remote itself is S12, confirmed with the user at S11. Nothing in this repository pushes to `neogeeks/tx402` without explicit approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **User** / Agent | ✅ Resolved S11 (remote move still S12)            |
| O4  | Informational size ceiling. **Resolved at S3, amended at S4 and again at S5.** M1 froze 24 KiB, M2 amended to 28 KiB, and M3's payment path made the total 28.39 KiB, so ADR-008 now sets 30 KiB — and states the re-baseline as a policy rather than repeating it as an exception: the blocking own-code gate stays at 25 KiB and never moves, the total is a tracking number re-baselined only by an ADR amendment recording the measurement, and it freezes for good at M8. S5 also corrected the measurement itself: the lazy `import()` targets in `core/chain.ts` are now external, so adapter bytes stop being reported as core bytes. Actual M3 own code is 13.69 KiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Agent            | ✅ Resolved S5 (policy stated)                     |
| O5  | `routing.maxQuoteAgeMs` is inert for standard v2 challenges (no upstream timestamp). **Resolved at S4:** PolicyEngine checks RFC3339 `extra.timestamp` only when present, after rolling-budget evaluation; stale, invalid, and >15 s future metadata are covered. Standard v2 remains a documented no-op.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Agent            | ✅ Resolved S4                                     |
| O6  | Upstream `@x402/*` is on a fast release cadence. Every bump replays all conformance fixtures per SPEC §15. **Re-verified at S6 because the optional Solana peer surface changed, with no version bump:** installed `@x402/svm` remains 2.20.0 and `@solana/kit` resolves to 5.5.1. `ExactSvmScheme` still obtains mint metadata through `@solana-program/token` 0.9.0 / token-2022 0.6.1, derives canonical ATAs, creates a versioned transaction, and invokes a `TransactionSigner`; tx402 now directly declares the same 0.9.0 SPL parser/PDA dependency as an optional peer so its pre-sign validator does not rely on transitive resolution. The M3 EVM findings remain unchanged. Recheck at every dependency bump.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Agent            | ⬜ Ongoing                                         |
| O7  | SPEC §12.1 asks for Windows CI "where supported". **Resolved at S12.** S1 deferred it on the grounds that nothing platform-sensitive existed; the CLI is what changed that, since `--body @file` reads from disk and the console script is resolved by the platform's own launcher. CI now runs a `cross-platform` job on `macos-latest` and `windows-latest` covering both suites and a CLI smoke on each. The full Node 20/22 × CPython 3.10–3.13 matrix stays on Linux — these legs answer "does it work at all off Linux", which is the question that was actually open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Agent            | ✅ Resolved S1                                     |
| O8  | Independent security review (SPEC §12.4) needs a reviewer lined up well before S12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **User**         | 🟨 Deferred                                        |
| O9  | npm's 72-hour unpublish window on `tx402@0.0.0` closes **2026-08-05**. After that the version number is permanent and cannot be reused. No action needed — `0.0.0` is intended to stay burned — but any change of heart about the placeholder must happen before then.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Agent            | ⬜ Informational                                   |
| O10 | `publishConfig.provenance: true` is set on the npm package, but the S1 placeholder was published from a laptop with `--no-provenance` (provenance needs CI OIDC). The release workflow must **not** carry that flag, and trusted publishing must be configured on both registries before `0.1.0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Agent            | ⬜ Pending S12                                     |
| O11 | Test coverage thresholds. **Resolved at S2, two sessions early; the last exemption removed at S12.** 90 % line/branch/function/statement is enforced in `packages/tx402/vitest.config.ts` and in the Python `[tool.coverage.report] fail_under`. `src/tx402/cli.py` was the one omission and it left `[tool.coverage.run] omit` in the same change that landed the Python CLI, so `omit` is now empty. Actual at S12: TS 94.18 % stmts / 90.53 % branch, Python 92.18 % with the CLI inside the gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Agent            | ✅ Resolved S2                                     |
| O12 | **Backup half resolved S11; rotation still open.** The dev signing key `tx402-release-1` is now backed up off this machine by the user and verified by a deterministic re-sign roundtrip: Ed25519 signing is byte-identical for the same key and message, so re-signing the manifest with the restored key and finding `git diff --quiet core-spec/manifests/bundled.manifest.json` proves the backup is the same key rather than merely a well-formed one. `pnpm manifest:verify` at S11 reports OK — release 0.1.0, signed by `tx402-release-1`, four networks, expires 2027-08-02. **What remains open:** before `0.1.0` a release key must be generated in a secure environment and held in CI OIDC or a secret manager (SPEC §13); the dev key must not sign a published release. Do not close this item on the strength of the backup. Runbook: `docs/operations/release-manifest.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **User** / Agent | 🟧 Backup done S11; **rotation due S12**           |
| O13 | Solana RPC redundancy. **Resolved at S6.** Mainnet already had the independent keyless `https://rpc.solanatracker.io/public`. A live `getGenesisHash` probe against OnFinality's keyless `https://solana-devnet.api.onfinality.io/public` returned Devnet's canonical `EtWTR...PkrZBG` full hash, so it is now the signed manifest's second Devnet RPC. The SVM pool caps use at two providers, proves genesis on each, fails over on deadline, mismatch, malformed ATA, and transport/protocol failure, and never exposes URL paths or queries in diagnostics. Full HealthIndex scoring remains M5 rather than part of this item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Agent            | ✅ Resolved S6                                     |
| O14 | The bundled manifest expires **2027-08-02**. After that no client can be constructed until it is re-issued. `manifest:verify` warns below 90 days remaining. Re-issue is a patch release (SPEC §15).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Agent            | ⬜ Informational, due 2027-05                      |
| O15 | Conformance gaps left at M0. **Resolved at S7.** The remaining route-candidate and ordering vectors are indexed: four `routing.candidate-order` and two `health.circuit`, taking the suite to 59. The health expectations were derived from a reference implementation written independently from the SPEC §6.5 table rather than read out of the SDK, and the `failure-rate` vector opens a circuit through the rate rule alone — twelve samples, consecutive count two — so an implementation that collapsed the two thresholds into one cannot pass both vectors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Agent            | ✅ Resolved S7                                     |
| O16 | GitHub Actions' deprecated Node 20 action runtime. **Resolved at S4 and verified in CI #6:** CI now uses official `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`, and immutable `astral-sh/setup-uv@v9.0.0`, all on the Node 24 action runtime. setup-uv's prior cache pruning is explicit. The application matrix still tests Node 20 and 22.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Agent            | ✅ Resolved S4                                     |
| O17 | **Resolved at S12.** Both root documents now exist. `SECURITY.md` points at GitHub Private Vulnerability Reporting on `neogeeks/tx402` (no disclosure email is needed — `PROJECT_URLS.security` was already wired at S11), states explicit scope and response times, and lists the tested guarantees a report can be filed against. `CONTRIBUTING.md` leads with the three rules that actually get a PR rejected — SPEC governs, the 65 fixtures are frozen, and behavioural changes land in both languages together — and records the concrete traps: integer money, signer-after-reservation, no composed-cancellation deadlines, no hand-edits to generated files, no raw NUL bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Agent            | 🟨 Deferred S11                                    |
| O18 | **Resolved at S8.** The re-challenge loop, `maxPaidAttempts`, fresh-challenge parsing, and T-010/T-011/T-012 all landed. SPEC §6.7's rules live in one pure function (`core/completion.ts`) that the request path consults and six conformance vectors pin, so the money rule is stated once and inherited by Python rather than re-derived. What S5 built is unchanged and now runs inside the loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Agent            | ✅ Resolved S8                                     |
| O19 | **Resolved at S7 by deletion, not by layering.** `EvmRpcPool` no longer has `openUntilEpochMs` or `consecutiveFailures`; it asks the client's single `HealthIndex` whether an endpoint may be used and reports the outcome with a latency. `CIRCUIT_OPEN_MS` in `core/chain.ts` is now a re-export of `HEALTH_OPEN_MS`, so the 30-second figure exists once. There is no second place for circuit state to live, which makes the "two circuits disagree" failure mode unreachable rather than merely untested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Agent            | ✅ Resolved S7                                     |
| O20 | **Resolved at S7.** `planRoutes` runs every probe under one `Promise.all`, and a `BalanceProbeCache` memoizes on the in-flight promise keyed by network, asset, and owner, so requirements sharing all three join one query instead of racing two. The two-provider cap stays where it was, in each pool's constructor. A unit test asserts peak concurrency of three probes against two distinct reads, and T-008's warmed decision p95 is well inside the 150 ms gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Agent            | ✅ Resolved S7                                     |
| O21 | **Resolved at S5.** S5's three intermittent CI failures were three production defects in guard code: an EVM authorization clock-boundary race, a weakly held composed timeout signal, and a broken abort-follow chain across successive `Request` objects. Deadlines are now enforced by promise races in tx402 control flow, and authorization bounds are computed only after the values they constrain exist. Runs #13, #14, and #15 were all 7/7 green and the failing pair ran clean locally 100 consecutive times. The workflow's failure-annotation diagnostic is deliberately retained; read it before changing code on any future red run. S6 follows both rules in the Solana RPC and signer adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Agent            | ✅ Resolved S5                                     |
| O22 | **Resolved at S7 alongside O19.** `SvmRpcPool` lost its own `openUntilEpochMs` and reports into the same `HealthIndex` as the EVM pool, namespaced `<caip2>\|<host>` so a provider serving several chains is scored per chain. A genesis-hash mismatch still opens immediately, via `HealthIndex.open`, which is reserved for the SPEC §7.1/§7.2 chain-identity rules — those are not reliability samples to average into a window, and both clauses require moving to the next RPC now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Agent            | ✅ Resolved S7                                     |
| O23 | **Resolved S11.** The exposed PyPI upload token was revoked by the user. **No replacement token was issued and none should be** — S12 configures OIDC trusted publishing on both registries (O10), so no long-lived upload credential needs to exist again. Real releases remain CI-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **User**         | ✅ Resolved S11                                    |
| O24 | A test transport that rebuilds an outbound request as `new Request(input, init)` **drops the per-provider deadline signal**, because a rebuilt Request only _follows_ the original's signal through a WeakRef. S7's first failover harness did exactly that and the suite hung until it was killed — against a stub that never answers, a broken follow chain is not a slow test, it is no deadline at all. This is S5's `withDeadline` lesson reappearing in test code. Shims must forward `init` by identity; worth a shared test helper at S12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Agent            | 🟨 Convention, revisit S12                         |
| O25 | **Resolved at S12.** `tools/nul-check` fails if any tracked non-binary file contains a raw NUL, and runs in CI on the TypeScript leg. It checks by _symptom_ — git treats such a file as binary, so it cannot be diffed or grepped, which is the actual damage — rather than by guessing at suspicious characters. **It caught two on its first run**, in `CONTRIBUTING.md` and in its own docstring, both from writing the escape sequence through a shell heredoc: the S7 failure reproduced within minutes of the guard existing, which is the best possible argument for the guard. Original S7 context: a cache-key separator written as a literal control character passed lint, format, types, tests, coverage and size.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Agent            | 🟨 Guard due S12                                   |
| O26 | **Decided at S12 — see ADR-014.** v0.1 follows **no** redirect on a paid retry, same-origin included; the follow is deferred to v0.2. The reasoning that settled it: following means either re-transmitting one authorization to a second URL — a new replay surface, and "same origin" is not "same party" when an open redirect on the merchant's own host is a common web vulnerability — or re-planning and re-signing, which is a second payment for one resource. Between an unnecessary failure and an unintended transmission of an authorization, v0.1 takes the failure. SEC-005's "fail **before transmitting**" wording is recorded in the ADR as the strongest argument the other way rather than dismissed. No code changed: the behaviour and its three frozen `completion.paid-attempt` vectors already encode this, and the ADR exists so a future reader finds a decision rather than an omission. The CLI grew no `--follow-redirects` flag, deliberately. A v0.2 design sketch is in the ADR so the deferral costs no analysis.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Agent            | 🟨 Deferred S11                                    |
| O27 | The conformance fixture set is **frozen at 65 vectors** as of S8 (2026-08-03) and Python is written against it at S9/S10. Adding a vector remains ordinary work; changing or removing one is a contract change. When a Python run disagrees with a frozen vector, establish whether the defect is in Python, in TypeScript, or in the vector's reading of SPEC **before** editing any file — editing the fixture first is how a cross-language contract quietly becomes a record of whatever the two implementations happen to do. Rules and rationale: `core-spec/conformance/README.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Agent            | ⬜ Standing rule from S8                           |
| O28 | **S9 open-item audit.** The frozen fixtures passed unchanged, and no new specification deviation was found. PyPI `x402` is pinned to the inspected 2.17.* line and agrees with npm's 2.20.0 v2 envelope at the tx402 boundary (O6 remains ongoing). Python owns deadlines explicitly and its test transports preserve the original HTTPX request, satisfying O21/O24. O2, O10, O12, O17, O25, and O26 retain their existing owners and dates: wallets/trusted publishing/NUL guard at S12, security/contribution docs and redirect decision at S11, and the manifest-key backup needed from the user now. O27 continues to govern S10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Agent / **User** | 🟨 Re-deferred to recorded milestones              |
| O29 | **`openedAtEpochMs == 0` is the "circuit closed" sentinel in both SDKs**, so an endpoint whose circuit opened at exactly epoch 0 reads as closed. Unreachable in production — a real clock is never 0 — and the frozen `health.circuit` vectors use a plausible instant, so the two languages agree. It was found by a Python unit test that opened a circuit at `0` and is recorded rather than fixed one-sidedly: giving Python a different sentinel would break the parity the vectors exist to hold. Fix in both languages together at S12 by making the field optional, or accept and document it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Agent            | 🟨 Convention, revisit S12                         |
| O30 | **`ExactSvmScheme` in PyPI `x402` is unusable by tx402 on two counts** — its signer contract is a raw `Keypair` (SEC-001, SPEC §7.2) and the module fails to import against `solana` 0.40, which removed `solana.rpc.api`. ADR-013 records the resulting decision to compile the transaction from `solders`. This is the specific thing O6 must re-check on every PyPI `x402` bump: if a later release accepts a signing interface and imports cleanly, delegating becomes possible again and ADR-013 should be revisited. The TypeScript side is unaffected — `@x402/svm` takes an interface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Agent            | ⬜ Ongoing, tied to O6                             |
| O31 | **S10 open-item audit.** The frozen fixtures passed unchanged and no new specification deviation was found beyond ADR-013. Four S9 Python client tests encoded a pre-M6 approximation and were corrected against the vectors, not the reverse (O27 followed). O19/O22's one-circuit property now holds in Python too. O24's rule was followed: the new test transports forward the original request, and deadlines are raced in tx402's own control flow. O25's scan is clean across all 227 tracked files. O2, O10, O12, O17, and O26 retain their existing owners and dates: wallets and trusted publishing at S12, the manifest-key backup needed from the user now, security/contribution docs and the redirect decision at S11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Agent / **User** | 🟨 Re-deferred to recorded milestones              |
| O32 | **macOS TCC can revoke an agent's filesystem access mid-session, and it does not look like a permissions bug.** This ended S10's follow-up work before it could verify anything or update this plan. **Symptom:** every read under `~/Documents` fails with `Operation not permitted`, while `~/` and `/tmp` keep working normally — so the tooling looks healthy and only this repository is unreachable. **Why the obvious workaround fails:** TCC (Transparency, Consent and Control) sits _above_ the sandbox, so `dangerouslyDisableSandbox` does not help and neither does any flag the agent controls. **Fix:** grant the terminal application Full Disk Access in System Settings → Privacy & Security, then **relaunch the terminal** — the entitlement is read at process start, so a running process keeps the old denial. A future session that sees `Operation not permitted` on this repo should recognise it as this, not as a corrupted checkout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Agent            | ⬜ Informational, recognise the symptom            |
| O33 | **The opt-in live suites silently skip when the environment variable names or formats are wrong, and a skip is indistinguishable from an unfunded wallet.** Found at S11, when all three failure modes were present at once in the user's local `.env`: the keys were named `EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` rather than the `TX402_BASE_SEPOLIA_PRIVATE_KEY` / `TX402_SOLANA_DEVNET_KEYPAIR` the suites read; the EVM key was bare 64-hex with **no `0x` prefix**; and the Solana key was a **base58 string rather than the 64-byte JSON array** `createKeyPairSignerFromBytes` needs. `describe.skipIf` then reports a clean green run having tested nothing. Note also that **`.env` is not auto-loaded by vitest or pytest** — it must be sourced (`set -a; . .env; set +a`) or wired explicitly. S11 added `.env.example` with the canonical names plus a normalising loader so this cannot recur silently; the wallets themselves were never the problem (O2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Agent            | ⬜ Standing trap, mitigated S11                    |
| O34 | **Resolved at S12, and the open item's own diagnosis was wrong.** S11 proposed two fixes — quantise `observedLatencyMs` into buckets, or demote it below requirement index — and flagged both as frozen-vector contract changes. Instrumenting the ordering keys across eight runs before touching anything ruled out **both**: `health_score` is itself latency-derived and varies at its own four-decimal resolution (0.8398 against 0.8397 between runs), so it decides some passes and raw latency decides others. Coarsening or demoting the key below the score leaves the key above it just as noisy — both fixes would have changed contract surface in two languages and left the flake in place. The real defect was the test's premise: SPEC §6.4 step 19 conditions determinism on "identical inputs **and health state**", and both measured keys are fresh wall-clock readings, so five fresh clients are five different health states. TypeScript never flaked because its counterpart pins `preferNetworks` and never reaches the measured keys; Python's test was the outlier. `order_route_candidates` is unchanged in both languages; the end-to-end test now holds every key above the measured ones fixed, and step 19's real content is asserted directly in both suites. 12/12 clean under coverage, against ~1 in 4 before. The residual product behaviour — with no preference and equal price, the marginally faster network wins and that can vary — is documented in `docs/src/content/docs/guides/routing.mdx` rather than engineered away.                                                                                                                                                                                                                                                                                | Agent            | ✅ Resolved S12                                    |
| O35 | **T-019's Solana Devnet leg cannot complete against free keyless RPC endpoints, and this is a quota rather than a rate.** Found at S12. The Base Sepolia leg is clean — 50/50 delivered, 50 distinct signature digests, no untyped exception, no degradation — but the Solana leg delivers exactly **8** and then fails every remaining call with a typed `TX402_TRANSPORT`. Pacing at 600 ms and at 2 000 ms produces the _same_ cutoff at 8, which rules a rate out; instrumenting the RPC traffic showed each Solana payment costs **five** Devnet requests (2 × `getGenesisHash`, 2 × `getAccountInfo`, 1 × `getLatestBlockhash`), and both manifest endpoints start returning 429 after roughly forty requests from one IP. tx402's own behaviour is correct throughout: it fails over, opens both circuits, and refuses to sign, so SPEC §12.2's actual criterion — zero SDK-caused signature failures, zero unhandled exceptions — holds. **The assertions were deliberately not weakened to make it pass.** To claim T-019 in full, the release run needs a Devnet endpoint with adequate quota (a keyed provider, or a local validator); the suite should take an RPC override rather than the signed manifest deciding for it. Also seen once and unexplained: call 9 surfaced as `TX402_SIGNER` rather than `TX402_TRANSPORT`, so a 429 arriving during authorization creation may be misclassified as a signer failure. That is a diagnosis-quality issue, not a money-safety one, and needs its own look.                                                                                                                                                                                                                                                                                                                                  | Agent            | 🟥 Open — blocks the T-019 claim                   |
| O36 | **A verification row for a cached tool must be written after a cache-cold run.** S11 recorded "strict mypy clean"; two `unused-ignore` failures in `tests/test_diagnostics.py` were in fact present on that clean tree, confirmed at S12 by stashing every change and re-running mypy with a fresh cache directory. Both are fixed. This is the S5 process note ("write the row after the result, never in anticipation of it") in a new form: the result was real, but it came from a cache that had not seen the files it was reporting on. `mypy`, `ruff`, `tsc --incremental`, and `vitest`'s cache all have this property; CI is cache-cold and would have caught it, which is a second argument for not recording a local-only gate as final.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Agent            | ⬜ Standing rule from S12                          |
| O37 | **An invalid job-level context makes a GitHub Actions run fail with zero jobs and no readable error. Resolved at S13.** `name: ${{ matrix.os }} (Node ${{ env.NODE_VERSION_DEFAULT }})` looks harmless; a job-level `name` may only read github/needs/strategy/matrix/vars/inputs, and GitHub rejects the **whole workflow** rather than interpolating an empty string. The run completes as `failure` with no jobs, no check runs, and no annotations — and log download needs auth the agent does not have (the O21 situation), so there is nothing to read. `tools/workflow-lint` now parses every workflow, rejects a disallowed context in `name`/`runs-on`/`if`, and catches a job missing `runs-on`/`steps` or a dangling `matrix.<key>`. Verified by reintroducing the exact expression and watching it fail. Runs in `pnpm check` and on the TypeScript CI leg.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Agent            | ✅ Resolved S13                                    |
| O38 | **A local gate can pass on state a clean checkout does not have, and S13 hit two at once.** (1) `pnpm lint` and `pnpm typecheck` passed locally because `packages/tx402/dist` existed from an earlier build; `examples/typescript` imports `tx402` through its emitted declarations, so in CI — which lints before building — every import resolved to `any` and every `no-unsafe-*` rule fired. Build now runs first. (2) `pnpm format` reflowed `<Tabs>` nested in `<Steps>` list items into something Astro's MDX parser rejects, and rewrote the MDX comment `{/* … */}` into `{/_ … _/}` by reading the asterisks as emphasis — **after** the successful `docs:build` was observed. `docs:check` only compares the two _generated_ pages, so it could never have caught it. Prettier no longer formats `docs/src/content/docs/`, and `pnpm docs:build` joined `pnpm check` as the real validator. General rule, alongside O36: a gate is only evidence if it ran in the order and from the state CI uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Agent            | ✅ Resolved S13                                    |
| O39 | **Windows checks out CRLF by default, which changes every conformance vector's hash. Resolved at S13.** Git on Windows defaults to `core.autocrlf=true`. tx402 hashes files and verifies signatures over their bytes (SEC-007), so a CRLF checkout invalidates all 65 vector hashes and the signed manifest — a Windows contributor could not get a green checkout of a clean tree. Found by the O7 cross-platform leg on its **first** run, which is the argument for having added it, and reproduced locally by converting one vector to CRLF and watching `conformance:check` report it content-changed. `.gitattributes` now normalises everything to `eol=lf` and marks the hash- and signature-bearing files `-text` so no future autocrlf setting or editor can touch them. The index was already pure LF, so nothing was rewritten.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Agent            | ✅ Resolved S13                                    |
| O40 | **Solana now has the same level of proof as Base. Settlement half resolved at S13.** Base had a live suite, a 50/50 volume run and a real settled payment; Solana had a live suite that stopped at the signature, a volume leg blocked by O35, and no settled payment ever. Closing that was in the S12 handoff's scope — it named Solana's facilitator fee payer explicitly — and was missed; the user caught it. **Two Devnet payments now settle through `https://x402.org/facilitator`.** The first, `cC5hoB8y…YphLBzS`, proved the pipeline but paid the payer's own address, so balances did not move and it answered nothing about value leaving — the same trap the first Base run fell into. The second, `4TRZkmKX…qwRc6JYj`, is the real one: confirmed at slot 481100292 with `err: null`, payer `9VyoFEDVasUj…` **30 → 29.999 USDC**, recipient `9WzDXwBbmkg8…` **476.75102 → 476.75202**, and the 10 001-lamport fee paid by the published fee payer `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5`, so the buyer's SOL is untouched at 5.00125. The recipient was chosen because its USDC associated token account already exists: an arbitrary Devnet address has none and the transfer fails `/settle` with `transaction_simulation_failed`, which is what made the first attempt look like a tx402 defect when it was a missing account. **Remaining:** generalise `tools/ttv` to take a network argument instead of hard-coding Base, and record a Solana TTV number beside the 1.66 s Base one; O35 still gates the 50-call volume leg independently. Also found: when settlement fails, `tools/test-merchant` answers 402 **without** a `PAYMENT-REQUIRED` header, so the buyer reports `missing-header` rather than the real cause — a fixture defect that made the first failed attempt much harder to read than it needed to be. | Agent            | 🟧 Settlement proven S13; TTV tooling + O35 remain |

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

---

## 11. Release Sequence & Pre-Publication Gates

**This section is normative for sequencing and was set by the user at S13. No session may
skip a stage or run two in one sitting.**

### 11.1 The order, and where each stage happens

```
  remaining dev sessions        ──▶  on tx402-dev
  pre-publication audit (§11.2) ──▶  on tx402-dev        ← no publishing planned yet
  fresh-eyes UX pass    (§11.3) ──▶  on tx402-dev, COLD start
  ─────────────────────────────────────────────────────
  only now: plan the publish (§11.4) — neogeeks/tx402, npm, PyPI
```

Three rules that are easy to violate and expensive to undo:

1. **Everything up to and including the UX pass happens on `tx402-dev`.** `origin` stays
   `jaykomarraju/tx402-dev`. Nothing touches `neogeeks/tx402`.
2. **The migration to `neogeeks/tx402` is not planned, scaffolded, or rehearsed until the
   audit is complete.** Not a branch, not a workflow, not a checklist. Planning the publish
   before knowing what the audit finds is how an audit becomes a formality.
3. **The audit and the UX pass are separate sessions with different postures.** The audit
   reads everything and distrusts it. The UX pass reads almost nothing and behaves like a
   stranger. Merging them destroys the second one, because you cannot un-know the codebase.

If either stage produces required changes, those land as ordinary dev work and the affected
stage is **re-run**. A stage is complete when it runs clean, not when its findings are filed.

### 11.2 Pre-publication audit charter

One session, on `tx402-dev`. Its output is findings and — only where a finding proves it
necessary — changes. It is not a feature session.

**The governing instruction: do not trust the existing tests as proof that the product
works.** They were written by the same model that wrote the implementation, against that
model's own understanding of the behaviour. That is a correlated blind spot, not coverage.
S12's O34 is the precedent: a test asserted something the specification never promised, and
every gate agreed with it for a session.

**1. Repository-wide correctness audit.** Inspect the whole repository before changing
anything. Identify:

- features that appear implemented but are not actually complete;
- stubbed, mocked, hardcoded, or placeholder behaviour;
- broken connections across the real boundaries in this project — SDK ↔ CLI, core ↔ chain
  adapters, buyer ↔ merchant ↔ facilitator, SDK ↔ signed manifest, docs site ↔ generated
  pages, and the spend ledger, which is this project's "database";
- routes or functions never exercised;
- incorrect assumptions made during implementation;
- silent failures and swallowed exceptions;
- race conditions, retry issues, and partial-write scenarios — the reservation/commit/release
  path and the paid-retry disposition table deserve specific attention;
- code that works only on the happy path;
- documentation that no longer matches behaviour.

**2. Adversarial test design.** Derive expected behaviour _independently_, from the README,
`PRD.md`, `SPEC.md`, the public interfaces, the CLI help text, the API reference, the
examples, and plain user expectation — then compare that against the implementation. Do not
start from the existing tests. Prioritise, in roughly this order:

fresh installation on a clean machine · first-run behaviour with an empty ledger · invalid
configuration · missing environment variables · expired or incorrect credentials · network
timeout and third-party outage · duplicate requests · concurrent requests · interrupted
operations · upgrade from an older version · different operating systems and runtime
versions · malformed user input · large inputs · uninstall and cleanup · public API
backward compatibility.

**3. Security and release-readiness review.** Framed as a defensive review of our own
repository. Examine: secrets accidentally committed; unsafe defaults; authentication and
authorization boundaries; input validation; injection risks; SSRF, path traversal, and
insecure file handling; dependency risks; overly broad permissions; sensitive information in
logs; rate limiting and abuse scenarios; supply-chain and package-publishing configuration;
license and attribution; and whether the examples encourage insecure usage.

**4. Maintainer-quality review.** A project can be correct and still be painful to
contribute to. Ask whether an unfamiliar developer could install it without help, understand
the architecture, run the tests locally, add a feature safely, diagnose a common error,
submit a useful issue, contribute without learning undocumented conventions, and upgrade
without breaking their system. Cover: README, quick start, architecture documentation,
configuration reference, contribution guide, code of conduct, security policy, license,
changelog, versioning policy, release process, example applications, and error messages.

### 11.3 Fresh-eyes UX pass charter

One session, on `tx402-dev`, and the **only** session in this plan that does not begin by
reading `PLAN.md`.

**Start cold, deliberately.** Read what a new user reads — the README and the documentation
site — and nothing else. Do not open `PLAN.md`, `SPEC.md`, `PRD.md`, the ADRs, or the source
until the pass is finished. The point is to find what the documentation fails to say, and
that is unrecoverable once the codebase has been read.

Then **actually use the product**: install both packages as a user would, follow the
quickstart end to end, make a real settled testnet payment on both networks, run the CLI,
run the examples, and try to do something the docs do not explicitly cover. Record every
place reality and documentation diverge, every moment of confusion, and the real
time-to-value — a stopwatch, not an estimate, against SPEC §16's five minutes.

This is the last pass before publication.

### 11.4 Publishing (planned only after §11.2 and §11.3 are clean)

Not to be designed before then. It will cover the `neogeeks/tx402` migration, npm and PyPI
trusted publishing with provenance (O10), the rotated release signing key (O12), and the
SPEC §12.4 release gates. Until the two stages above run clean, the correct amount of
publish planning is none.
