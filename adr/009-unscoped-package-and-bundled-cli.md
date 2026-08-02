# ADR-009 — Unscoped `tx402` package with bundled CLI

**Status:** Accepted · **amends `SPEC.md`** §3.1, §4.1, §13, §16 and the document-control header

## Context

`SPEC.md` names the TypeScript package `@tx402/sdk` (scoped to a `@tx402` npm organization) and lays
out `packages/sdk-ts` and `packages/cli` as two separate publishable units, with the CLI delivered
as `npx tx402`.

Two problems:

1. A scoped `@tx402/sdk` requires creating and maintaining an npm organization, and reads as heavier
   than the product is. The Python package was already specified as the bare name `tx402`, so the
   scoped TS name also broke cross-language naming symmetry.
2. `npx tx402` only resolves to a CLI if a package literally named `tx402` exposes a `bin`. With the
   SPEC's split, `npx tx402` would not have worked as documented in SPEC §11 and PRD §"Terminal &
   CLI Debugging Experience".

Availability was verified at planning time: `tx402` is unregistered on both npm and PyPI
(both return 404).

## Decision

**One unscoped npm package named `tx402`**, matching the PyPI package name exactly. It exposes the
SDK and the CLI from a single publishable unit:

```jsonc
{
  "name": "tx402",
  "bin": { "tx402": "./dist/cli/index.js" },
  "exports": {
    ".": "./dist/index.js", // core import path — size-gated (ADR-008)
    "./evm": "./dist/evm/index.js",
    "./solana": "./dist/solana/index.js",
    "./signers": "./dist/signers/index.js",
  },
}
```

The public factory export remains `createTx402Client`, unchanged from SPEC §4.1 — only the module
specifier changes:

```ts
import { createTx402Client } from "tx402"; // was: "@tx402/sdk"
```

`packages/cli` from SPEC §3.1 is merged into `packages/tx402/src/cli/`.

## Consequences

- Every `@tx402/sdk` reference in SPEC.md (§4.1 example, §13 artifact registry, §16 definition of
  done, and the document-control "Primary packages" row) reads `tx402`.
- `npx tx402 call <URL>` works after `npm i tx402`, with no second install — as SPEC §11 always
  intended.
- The CLI is a **separate build entry** under `src/cli/`. It is deliberately outside the `.` export,
  so CLI dependencies (argument parsing, terminal rendering) never enter the core import path and
  never count against the ADR-008 blocking gate.
- Chain adapters stay behind `./evm` and `./solana` subpath exports so that `viem`, `@solana/kit`,
  `@x402/evm`, and `@x402/svm` are only paid for by users who import them.
- Private-key convenience adapters live behind `./signers`, kept isolated per SEC-001 — the primary
  client config accepts signer abstractions only, never raw key strings.
- No `@tx402` npm organization is created. One name to reserve per registry, not two.
