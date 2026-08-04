# ADR-008 — Bundle size gate re-baseline

**Status:** Accepted · **amends `SPEC.md` §12.3**

## Context

`SPEC.md` §12.3 sets a release-blocking gate:

> TypeScript published core import path gzipped size gate: `<25 KiB` excluding optional chain
> adapters.

`SPEC.md` §3.2 simultaneously requires that cryptographic and protocol primitives come from audited
upstream packages — the SDK **MUST NOT** reimplement secp256k1, Ed25519, Keccak, SHA-256, base58, or
the x402 envelope codec. The core import path therefore necessarily includes `@x402/core`.

Measured against the published `@x402/core` 2.20.0 ESM distribution:

| Artifact                                                   |      Raw |     Gzipped |
| :--------------------------------------------------------- | -------: | ----------: |
| `@x402/core` ESM dist (all entry points)                   | ~142 KiB | **~27 KiB** |
| `@x402/core` largest shared chunk (pulled in by `client/`) |  ~46 KiB |           — |
| `zod` ^3 (transitive dependency of `@x402/core`)           |        — |     ~13 KiB |
| `@x402/svm` ESM dist                                       |  ~80 KiB |     ~15 KiB |
| `@x402/evm` ESM dist                                       | ~320 KiB |     ~58 KiB |

The upstream dependency alone exceeds the 25 KiB figure before tx402 contributes a single byte. The
gate as literally written is unreachable for any implementation that also satisfies §3.2. It was
authored as a "zero bloat" intent (PRD §4 NFRs) without a measurement of the pinned dependency.

Three options were considered:

1. **Make `@x402/core` a `peerDependency`** so it is excluded from tx402's published bundle. Honest
   by the letter of the gate, but forces `npm i tx402 @x402/core` on every user, directly harming
   the `<5 minute` time-to-value objective (SPEC §1.1) and the "3 lines of code" positioning.
2. **Replace the gate with a single measured total-footprint number** (~50 KiB). Simple, but
   discards the signal that tx402's _own_ surface is staying lean, which is the property the gate
   was actually protecting.
3. **Split the gate.** Selected.

## Decision

The single 25 KiB gate is replaced by a **two-part measurement**:

- **Blocking gate — tx402 own code.** The gzipped size of the code tx402 itself emits on the core
  import path (`tx402` → `.`), with `@x402/core`, `zod`, and all optional chain adapters treated as
  external, **MUST** be `< 25 KiB`. This is release-blocking and preserves the original intent.
- **Reported metric — total core-path footprint.** The gzipped size of the core import path
  _including_ `@x402/core` and `zod` is measured, recorded in release notes, and checked against a
  ceiling. The ceiling is **not yet fixed**: it is set from a real measurement taken at M1
  (session S3) and frozen at that point by amending this ADR. Until then it is reported only.

Both numbers are produced by `tools/size-gate` and run in CI on every pull request. Optional chain
adapters (`tx402/evm`, `tx402/solana`) are measured and reported separately and are excluded from
both figures above, consistent with the original §12.3 carve-out.

## Consequences

- `SPEC.md` §12.3's size-gate bullet is superseded by this ADR. The specification text is left
  intact; this ADR is the operative rule.
- `@x402/core` remains a normal `dependency`, so `npm i tx402` stays sufficient and the TTV
  objective is preserved.
- A regression in tx402's own code cannot hide behind dependency weight, and dependency growth is
  still visible because it is tracked as its own reported number.
- Open item **O4** in `PLAN.md` §9 tracks fixing the reported-metric ceiling at S3. This ADR must be
  amended — not silently updated — when that number is frozen.

## M1 amendment — total core-path ceiling frozen (2026-08-02)

The first real M1 implementation measured **22.28 KiB gzipped** for the `tx402` core import path
with `@x402/core` and zod bundled (82.04 KiB raw). tx402's own emitted portion measured 7.68 KiB
gzipped and remained well below the separate 25 KiB blocking limit.

The total core-path ceiling is frozen at **24 KiB gzipped (24,576 bytes)** and is now enforced by
`tools/size-gate`. The rounded ceiling leaves modest variance for compiler and minifier patch
releases without permitting a new runtime dependency or a material upstream expansion to pass
silently. Any increase above 24 KiB requires an explicit amendment to this ADR with a new measured
baseline and rationale.

## M2 amendment — policy and ledger baseline (2026-08-03)

M2 adds the SPEC-required integer money parser, PolicyEngine, request fingerprinting, and atomic
SpendStore to the same `tx402` core path used by `createTx402Client`. These modules cannot be moved
behind an optional chain entry point or tree-shaken from the client constructor without weakening
SPEC §6.3 or SEC-002. With no dependency changes, the measured total became **25.79 KiB gzipped**
and tx402's own portion became **10.99 KiB gzipped**.

The total ceiling is therefore amended to **28 KiB gzipped (28,672 bytes)**. This gives the measured
M2 core 2.21 KiB (8.6 %) of build and implementation headroom while continuing to fail material
growth. The independent tx402-own-code blocking limit remains unchanged at 25 KiB; no runtime
dependency was added and no optional chain adapter entered the core path.

## M3 amendment — lazy adapter boundary and the re-baseline policy (2026-08-03)

Two changes, one mechanical and one numeric.

**The lazy adapter targets are now external to the core measurement.** `src/core/chain.ts` reaches a
chain adapter through `await import("../evm/adapter.js")`. Every real bundler code-splits a dynamic
import, so a caller who never pays on EVM never downloads the EVM adapter — but esbuild, run with a
single entry point and no splitting, inlines it and reported 3.6 KiB of adapter bytes as core bytes.
`tools/size-gate` therefore treats those two relative paths as external alongside `@x402/evm`,
`@x402/svm`, `viem`, and `@solana/kit`. This is the same carve-out SPEC §12.3 already makes for
"optional chain adapters", applied to the module that actually holds them; it is a correction to the
measurement, not a relaxation of the budget. The adapters remain measured and reported separately —
`tx402/evm` is 5.51 KiB gzipped at M3.

**The total ceiling moves to 30 KiB gzipped (30,720 bytes).** M3 adds the signer contract, the
core-to-adapter seam, and the SPEC §6 payment path — reserve, sign, retry, commit — to the same
core module `createTx402Client` returns. None of it can move behind an optional entry point without
putting SEC-002's ordering guarantee outside the code that has to enforce it. With no dependency
change, the measured total is **28.39 KiB gzipped** and tx402's own portion is **13.67 KiB gzipped**,
still comfortably inside the unchanged 25 KiB blocking limit.

**The re-baseline is now a stated policy rather than a repeated exception.** The total core-path
figure has been re-baselined at M1, M2, and M3, each time because a milestone added core code that
SPEC requires to be reachable from the client constructor. That will happen again at M5 (route
planner and health index) and M6 (completion semantics). The rule, stated once:

- The **blocking gate is tx402's own emitted core code at 25 KiB** and does not move. It is the
  measurement that actually protects the "zero bloat" intent, because it is the only one tx402
  wholly controls.
- The **total core-path ceiling is a tracking number**, re-baselined only by an amendment to this
  ADR that records the measurement, the milestone, and what was added. A re-baseline is never
  permitted to absorb a new runtime dependency, an optional chain adapter entering the core path, or
  growth in own code that would breach the blocking gate — any of those is a design change and needs
  its own decision.
- At M8 the ceiling is frozen against the finished implementation and stops moving.

## M5 amendment — routing and health baseline (2026-08-03)

The re-baseline the M3 amendment predicted for M5, applied under the policy it states.

M5 adds `core/health.ts` (the SPEC §6.5 circuit breaker and health index) and `core/routing.ts` (the
SPEC §6.4 route planner) to the core path. Neither can move behind an optional chain entry point:
`createTx402Client` constructs the single `HealthIndex` at configuration time, and the planner runs
before any adapter is loaded, deciding _which_ adapter to load. Putting either behind
`import("../evm/…")` would mean the route ordering that chooses between EVM and Solana lives inside
one of the two chains it chooses between.

The two files are also, in part, a **deletion**: the per-endpoint circuit state that M3 and M4 each
carried inside their RPC pool is gone, replaced by one shared index. That deletion lands in the
optional adapters, which is why `tx402/evm` grew only 0.91 KiB and `tx402/solana` 0.99 KiB while
absorbing the health-reporting call sites.

With no dependency change, the measured total is **30.55 KiB gzipped** and tx402's own portion is
**15.88 KiB gzipped** — 9.12 KiB of headroom against the unchanged 25 KiB blocking limit.

The total core-path ceiling is amended to **32 KiB gzipped (32,768 bytes)**, leaving 1.45 KiB (4.7 %)
over the M5 measurement. One re-baseline remains anticipated, at M6 for the completion semantics,
after which M8 freezes the number for good.
