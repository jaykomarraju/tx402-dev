# tx402

**Resilient x402 buyer SDK for TypeScript.** Deterministic multi-chain payment routing, local
spend guardrails, and a drop-in `fetch` wrapper for autonomous agents.

> ⚠️ **This is a placeholder release (`0.0.0`). The package name is reserved; the SDK is under
> active development and nothing is implemented yet.** Do not depend on this version. The first
> functional release will be `0.1.0`.

## What it will do

An AI agent running a 50-step workflow cannot afford to have step 45 die because one payment
facilitator rate-limited it or the merchant wanted USDC on a chain the agent wasn't configured
for. `tx402` wraps a normal HTTP client and handles the `402 Payment Required` handshake:

```ts
import { createTx402Client } from "tx402";

const client = createTx402Client({
  signers: { evm, solana },
  policy: {
    maxPerRequest: "0.50 USDC",
    maxPerHour: "10.00 USDC",
    allowedNetworks: ["eip155:8453", "solana:mainnet"],
  },
});

const response = await client.fetch(url, init);
```

Under the hood, on a `402`, it will: decode the challenge, enforce your spend policy **before any
key is touched**, deterministically pick a route across the networks the merchant actually offered
(scored by balance, fee, and local endpoint health), reserve the spend, sign one authorization, and
retry exactly once with it.

## Design commitments

- **Non-custodial.** The core API accepts signer abstractions, never raw private key strings.
  Private keys never leave your process, and are never logged or transmitted.
- **Policy before signature.** Budget caps, domain allowlists, and network allowlists are evaluated
  and the spend is reserved _before_ a signer is ever invoked.
- **Integer money.** All amounts are integer atomic units. Floating-point money inputs are rejected,
  not coerced — a cap that rounds is not a cap.
- **No backend.** No tx402-operated service, no telemetry, no phone-home. The only network calls
  are to the merchant you asked for and the RPC endpoints you configured.
- **Same-chain only.** It pays on a network the merchant offered and you can sign for. It will not
  bridge or swap behind your back; if you can't pay, you get a typed `InsufficientLiquidityError`.

## Install

```bash
npm install tx402
```

Chain support is behind optional subpath exports (`tx402/evm`, `tx402/solana`) so you only pay for
what you import. The CLI ships in the same package:

```bash
npx tx402 call https://api.example.com/v1/inference --max-spend "0.10 USDC" --dry-run
```

## Status

Pre-alpha. Targeting Base and Solana for the first release, with a Python SDK
([`tx402` on PyPI](https://pypi.org/project/tx402/)) at behavioral parity.

## License

Apache-2.0
