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
