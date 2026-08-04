# tx402

**Resilient x402 buyer SDK for TypeScript.** Deterministic multi-chain payment routing, local spend
guardrails, and a drop-in `fetch` wrapper for autonomous agents.

[Documentation](https://tx402.dev/docs) · [Quickstart](https://tx402.dev/docs/start/quickstart/) ·
[Errors](https://tx402.dev/docs/reference/errors/) ·
[Source](https://github.com/neogeeks/tx402) ·
[Python SDK](https://pypi.org/project/tx402/)

> **`0.0.0` is an inert name placeholder and contains no working code.** The first functional
> release is `0.1.0`. Do not depend on `0.0.0`.

## Why

An AI agent running a fifty-step workflow cannot afford to have step 45 die because the merchant
wanted USDC on a chain it wasn't configured for, or because an RPC endpoint went dark. `tx402`
wraps a normal HTTP client and completes the `402 Payment Required` handshake:

```ts
import { createTx402Client } from "tx402";

const tx402 = createTx402Client({
  signers: { evm, solana },
  policy: {
    maxPerRequest: "0.50 USDC",
    maxPerHour: "10.00 USDC",
    allowedNetworks: ["eip155:8453", "solana:mainnet"],
  },
});

const response = await tx402.fetch(url, init);
```

On a `402` it decodes the challenge strictly, enforces your spend policy **before any key is
touched**, deterministically picks a route across the networks the merchant actually offered
(scored by balance, fee, and local endpoint health), reserves the spend atomically, signs exactly
one authorization with a fresh nonce, and retries once with it.

If the resource can't be paid for, you get one of fifteen typed errors telling you which thing went
wrong — not a bare `402`.

## Install

```bash
npm install tx402
```

Node 20 or newer. Chain support sits behind optional subpath exports, so importing `tx402` loads no
chain library at all:

```ts
import { privateKeyToEvmSigner } from "tx402/signers"; // dev convenience — warns on stderr
import { createEvmChainAdapter } from "tx402/evm"; // viem / @x402/evm
import { createSvmChainAdapter } from "tx402/solana"; // @solana/kit / @x402/svm
```

`EvmSigner` and `SolanaSigner` are two-method interfaces declared in the core path, so a KMS or
hardware signer is a first-class citizen rather than an escape hatch.

The CLI ships in the same package:

```bash
npx tx402 call https://api.example.com/v1/inference --max-spend "0.10 USDC" --dry-run
```

`--dry-run` plans the payment and prints what would be signed. It never invokes a signer and never
reserves budget. No flag accepts a private key, and none ever will.

## Design commitments

- **Non-custodial.** The core API accepts signer abstractions, never a raw private key string.
  Keys never leave your process and are never logged or transmitted.
- **Policy before signature.** Caps, allowlists, and the budget reservation are evaluated and
  committed _before_ a signer is invoked. A budget check that runs after signing is not a check.
- **Integer money.** Every amount is an integer in atomic units. A JS `number` is rejected, never
  coerced — a cap that rounds is not a cap.
- **No backend.** No tx402-operated service, no telemetry, no phone-home. The only hosts contacted
  are the merchant you named and the RPC endpoints you configured.
- **The buyer never settles.** tx402 does not call a facilitator's `/verify` or `/settle` and does
  not broadcast your transaction. The merchant owns settlement.
- **Same-chain only.** It pays on a network the merchant offered _and_ you can sign for. It will
  never bridge or swap behind your back — you get `InsufficientLiquidityError` instead.
- **Ambiguity is its own outcome.** A timeout after the signature went out means money may have
  moved. That is `AmbiguousPaymentError` with the reservation retained, never a silent retry.

## Networks

Base Mainnet, Base Sepolia, Solana Mainnet, and Solana Devnet, with USDC on each. The network list,
its assets, and its RPC endpoints ship as an **Ed25519-signed manifest** compiled into the package;
client construction fails if the signature does not verify.

## Parity with Python

[`tx402` on PyPI](https://pypi.org/project/tx402/) is the same product in Python, released at the
same version from the same commit. Both are held to identical behaviour — normalized output, route
ordering, error codes, and the money rule — by 65 shared conformance vectors.

## License

Apache-2.0
