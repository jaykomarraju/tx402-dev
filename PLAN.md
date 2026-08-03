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

**Current state:** _(updated end of S2)_ **public names are frozen.** `core-spec/` now holds the
JSON Schemas for every SPEC §5 shape, a signed release manifest covering all four networks, and
35 conformance vectors executed by a two-stage runner in both languages. The SPEC §8 error
taxonomy, tx402 canonical JSON, and offline manifest verification are implemented and exported
from both SDKs. A deterministic test merchant exists for every milestone from M1 on. Coverage
thresholds are enforced at 90 % in both languages. ADR-001..012 are recorded. The request loop
itself — `createTx402Client`, decode, policy, routing — is still unwritten and lands at M1 (S3).

**Sources of truth, in precedence order:**

1. `SPEC.md` — governs all v0.1 implementation behavior (its §0 says so explicitly).
2. `PRD.md` — product intent; explains _why_, never overrides _what_.
3. This plan — sequencing and process only. It never overrides SPEC behavior; where it deviates from
   SPEC, an ADR is required and is listed in §3.

**Development happens in `tx402-dev`.** The public open-source repo is a later migration; keep all
metadata (repo URLs, badges) behind a single constant so the move is a one-file change.

---

## 2. Locked Decisions (from this planning session)

| #   | Decision                                                                                                                                                                                                          | Consequence                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Package name is `tx402`, unscoped, on both npm and PyPI.** No `@tx402` org.                                                                                                                                     | Every `@tx402/sdk` reference in SPEC.md §4.1, §13, §16 reads `tx402`. Requires **ADR-009**.                                                                                                                      |
| D2  | **One npm package `tx402`** exposing the SDK at `.` and the CLI via a `bin` entry.                                                                                                                                | `npx tx402 call ...` works with zero extra install. Merges SPEC §3.1's separate `/packages/cli`. Covered by **ADR-009**. CLI code lives outside the core import path so it does not count against the size gate. |
| D3  | **Reserve both names by publishing a `0.0.0` placeholder.** npm immediately (already authed as `jay.komarraju`); PyPI as soon as an API token exists.                                                             | npm has no true reservation — publishing is the only hold. Placeholder is public; npm unpublish is only possible within 72h.                                                                                     |
| D4  | **Bundle-size gate re-baselined.** Blocking gate: tx402's **own emitted code** < 25 KiB gzipped. Informational: total core-path footprint incl. `@x402/core` + zod, ceiling frozen from a real measurement at M1. | SPEC §12.3's literal "<25 KiB core import path" is unreachable — measured `@x402/core` ESM at ~27 KiB gzipped alone, plus zod ~13 KiB. Requires **ADR-008**.                                                     |
| D5  | **TypeScript first through M6, then Python catches up against frozen conformance fixtures.**                                                                                                                      | Matches SPEC ADR-005 (TS is the reference implementation). Python inherits a settled design instead of tracking churn.                                                                                           |
| D6  | **`retryable` is derived from a six-value `retryability` classification; per-error data lives in `details`, not in the closed `Tx402ErrorContext`.**                                                              | SPEC §8's Retryable column has six values while §4.2 names one boolean. Requires **ADR-011**. Only `TransportError` reports `retryable: true`.                                                                   |
| D7  | **Manifests are signed over domain-separated tx402 canonical JSON; trusted keys are compiled into each package.**                                                                                                 | SPEC §5.4 defines the signature member but not the bytes it covers. Requires **ADR-012**. Adds `cryptography` to the Python core install — CPython has no Ed25519 and SPEC §3.2 forbids writing one.             |

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

### S4 — M2: TS Policy + Ledger

- Money parser: decimal-string → integer atomic units; reject JS `number` (ADR-006).
- PolicyEngine in SPEC §6.3 order; domain patterns on normalized host; network/scheme/asset gates.
- `SpendStore` contract + `MemorySpendStore`: atomic reserve/commit/release, 120 s TTL, rolling
  3 600 000 ms window over committed + active reservations.
- Request fingerprinting (SEC-009) with golden vectors for later Python parity.
- _Exit:_ T-006 (<2 ms, signer count 0), T-007 (concurrent atomicity) green; property tests green.

### S5 — M3: TS Base / EVM Adapter

- `EvmSigner` public interface → `ClientEvmSigner` adapter (§3).
- `ExactEvmScheme` wiring; USDC balance reads; **chain-ID verification before signing** (mismatch
  opens circuit, tries next RPC); optional `privateKeyToAccount` convenience adapter isolated under
  `tx402/signers` per SEC-001.
- _Exit:_ Base local + Base Sepolia paid calls pass.

### S6 — M4: TS Solana / SVM Adapter

- `SolanaSigner` → `@solana/kit` `TransactionSigner` adapter; `ExactSvmScheme` wiring.
- CAIP-2 alias resolution; genesis-hash cluster validation; ATA discovery + SPL balance;
  serialized-transaction size/account validation pre-signing.
- _Exit:_ Solana local validator + Devnet paid calls pass.

### S7 — M5: TS Routing + Health

- Deterministic RoutePlanner (SPEC §6.4 ordering, identical output for identical inputs).
- Concurrent balance fetch, 600 ms/provider, max 2 providers/network.
- HealthIndex: EWMA α=0.20, 20-observation window, open at 5 consecutive or ≥50 % of ≥10 samples,
  30 s open, 1 half-open probe, 128-entry LRU, 30 min idle retention.
- _Exit:_ T-004, T-005, T-008 (<150 ms p95 decision overhead), T-020 green.

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

| Session | Milestone                | Status         | Notes                                                                                                                   |
| ------- | ------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| S1      | Bootstrap & Reserve      | ✅ Complete    | 2026-08-02. Workspace, ADR-001..010, both package scaffolds, size gate, CI. npm name reserved; PyPI blocked on O1.      |
| S2      | M0 Spec fixtures         | ✅ Complete    | 2026-08-02. Names frozen. Schemas, signed manifest, 35 conformance vectors, error taxonomy, test merchant. ADR-011/012. |
| S3      | M1 TS transport/protocol | ⬜ Not started |                                                                                                                         |
| S4      | M2 TS policy/ledger      | ⬜ Not started |                                                                                                                         |
| S5      | M3 TS Base adapter       | ⬜ Not started |                                                                                                                         |
| S6      | M4 TS Solana adapter     | ⬜ Not started |                                                                                                                         |
| S7      | M5 TS routing/health     | ⬜ Not started |                                                                                                                         |
| S8      | M6 TS completion         | ⬜ Not started |                                                                                                                         |
| S9      | Python M1–M3             | ⬜ Not started |                                                                                                                         |
| S10     | Python M4–M6             | ⬜ Not started |                                                                                                                         |
| S11     | M7 CLI + docs            | ⬜ Not started |                                                                                                                         |
| S12     | M8 hardening + release   | ⬜ Not started |                                                                                                                         |

Legend: ⬜ not started · 🟨 in progress · ✅ complete · 🟥 blocked

**Normative test status (SPEC §12.2):** T-001 … T-020 — all ⬜. None were in scope at S2 either;
the first (T-001, T-009, T-013, T-018) land at S3. The test merchant now carries a scenario for
each of T-001, T-009, T-010, T-011, T-012, and T-017, so those tests have their fixture waiting.

**Name reservation:** npm `tx402` ✅ `0.0.0` published 2026-08-02 (maintainer `jay.komarraju`,
Apache-2.0, `bin` resolves so `npx tx402` works) · PyPI `tx402` ⬜ — distributions built and
verified at `packages/tx402-python/dist/`, publish blocked on open item **O1**. Runbook:
`docs/operations/publishing.md`.

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

Conformance suite composition: 24 M0 vectors execute against both implementations (Stage B); 11 M1
vectors — the seed valid/invalid v2 decode vectors — are validated against the frozen schemas and
taxonomy (Stage A) and become executable when the decoder lands at S3.

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

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Owner            | Status                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------- |
| O1  | PyPI account + API token needed to reserve `tx402` on PyPI (D3). Distributions are built and verified; only the credential is missing. Step-by-step in `docs/operations/publishing.md`.                                                                                                                                                                                                                                                              | **User**         | 🟥 Open                                      |
| O2  | Testnet wallets must be funded for Base Sepolia + Solana Devnet before S5/S6. Keep balances low and dedicated.                                                                                                                                                                                                                                                                                                                                       | **User**         | 🟥 Open, needed by S5                        |
| O3  | Public GitHub org/repo for the open-source migration. Keep repo URLs behind one constant until decided.                                                                                                                                                                                                                                                                                                                                              | **User**         | 🟨 Deferred                                  |
| O4  | Informational size ceiling (ADR-008) is a placeholder until measured for real at S3/M1.                                                                                                                                                                                                                                                                                                                                                              | Agent            | ⬜ Pending S3                                |
| O5  | `routing.maxQuoteAgeMs` is inert for standard v2 challenges (no upstream timestamp). **Resolved at S2:** documented in `docs/api/configuration.md` and in ADR-010 decision 3. S3 implements it as a conditional check that reads `extra` only, and the JSDoc on the field links to that page.                                                                                                                                                        | Agent            | ✅ Resolved S2                               |
| O6  | Upstream `@x402/*` is on a fast release cadence. Every bump replays all conformance fixtures per SPEC §15. **Re-verified at S2:** npm still publishes `@x402/core`, `@x402/evm`, `@x402/svm` at 2.20.0 and PyPI `x402` at 2.17.0 — no drift, so every ADR-010 decision stands unchanged.                                                                                                                                                             | Agent            | ⬜ Ongoing                                   |
| O7  | SPEC §12.1 asks for Windows CI "where supported". **Resolved at S1:** Linux-only for now. Nothing platform-sensitive exists yet — no filesystem paths, no shell-outs, no native bindings. macOS and Windows legs are added at S12 (M8) before release, when the CLI and file-based `--body @file` handling actually exist.                                                                                                                           | Agent            | ✅ Resolved S1                               |
| O8  | Independent security review (SPEC §12.4) needs a reviewer lined up well before S12.                                                                                                                                                                                                                                                                                                                                                                  | **User**         | 🟨 Deferred                                  |
| O9  | npm's 72-hour unpublish window on `tx402@0.0.0` closes **2026-08-05**. After that the version number is permanent and cannot be reused. No action needed — `0.0.0` is intended to stay burned — but any change of heart about the placeholder must happen before then.                                                                                                                                                                               | Agent            | ⬜ Informational                             |
| O10 | `publishConfig.provenance: true` is set on the npm package, but the S1 placeholder was published from a laptop with `--no-provenance` (provenance needs CI OIDC). The release workflow must **not** carry that flag, and trusted publishing must be configured on both registries before `0.1.0`.                                                                                                                                                    | Agent            | ⬜ Pending S12                               |
| O11 | Test coverage thresholds. **Resolved at S2, two sessions early.** 90 % line/branch/function/statement is enforced in `packages/tx402/vitest.config.ts` and in the Python `[tool.coverage.report] fail_under`. Actual: TS 99.37 % stmts / 97.57 % branch, Python 98.41 %. `src/tx402/cli.py` is omitted until M7 (S11).                                                                                                                               | Agent            | ✅ Resolved S2                               |
| O12 | The release manifest signing key `tx402-release-1` was generated locally at S2. The private half is gitignored at `core-spec/manifests/keys/tx402-release-1.private.pem` and **exists only on this machine — back it up.** Before `0.1.0` a release key must be generated in a secure environment and held in CI OIDC or a secret manager (SPEC §13); the dev key must not sign a published release. Runbook: `docs/operations/release-manifest.md`. | **User** / Agent | 🟥 Open, backup needed now; rotation due S12 |
| O13 | The bundled manifest gives each Solana network **one** RPC endpoint. No keyless public secondary was reachable at S2 — publicnode returned no route, and ankr and drpc both gate Solana behind an API key. Base has two working endpoints each. T-008/T-020 (RPC failover) use configured or mocked endpoints regardless, but a second Solana provider should be added before `0.1.0`.                                                               | Agent            | ⬜ Pending S6                                |
| O14 | The bundled manifest expires **2027-08-02**. After that no client can be constructed until it is re-issued. `manifest:verify` warns below 90 days remaining. Re-issue is a patch release (SPEC §15).                                                                                                                                                                                                                                                 | Agent            | ⬜ Informational, due 2027-05                |
| O15 | Conformance gaps knowingly left at M0, listed in `core-spec/conformance/README.md`: no oversized-header vector (needs ~87 KB of base64; lands at M1 with the fuzz corpus, generated not committed), no `route-candidate` or spend-ledger vectors (schemas frozen, no implementation to run yet), no SEC-009 request-fingerprint golden vectors (written at M2 with the fingerprint).                                                                 | Agent            | ⬜ Pending S3/S4                             |

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
