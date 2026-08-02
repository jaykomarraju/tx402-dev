# tx402

**Resilient x402 buyer SDK for Python.** Deterministic multi-chain payment routing, local spend
guardrails, and a drop-in `httpx` wrapper for autonomous agents.

> ⚠️ **This is a placeholder release (`0.0.0`). The package name is reserved; the SDK is under
> active development and nothing is implemented yet.** Do not depend on this version. The first
> functional release will be `0.1.0`.

## What it will do

An AI agent running a 50-step workflow cannot afford to have step 45 die because one payment
facilitator rate-limited it or the merchant wanted USDC on a chain the agent wasn't configured
for. `tx402` wraps a normal HTTP client and handles the `402 Payment Required` handshake:

```python
from tx402 import Policy, Tx402Client

client = Tx402Client(
    evm_signer=evm_signer,
    solana_signer=solana_signer,
    policy=Policy(
        max_per_request="0.50 USDC",
        max_per_hour="10.00 USDC",
        allowed_networks=["eip155:8453", "solana:mainnet"],
    ),
)

response = client.post(url, json={"prompt": "Hello"})
```

Under the hood, on a `402`, it will: decode the challenge, enforce your spend policy **before any
key is touched**, deterministically pick a route across the networks the merchant actually offered
(scored by balance, fee, and local endpoint health), reserve the spend, sign one authorization, and
retry exactly once with it.

Both `Tx402Client` and `AsyncTx402Client` are provided.

## Design commitments

- **Non-custodial.** The core API accepts signer abstractions, never raw private key strings.
  Private keys never leave your process, and are never logged or transmitted.
- **Policy before signature.** Budget caps, domain allowlists, and network allowlists are evaluated
  and the spend is reserved *before* a signer is ever invoked.
- **Integer money.** All amounts are integer atomic units. `float` money inputs are rejected, not
  coerced — a cap that rounds is not a cap.
- **No backend.** No tx402-operated service, no telemetry, no phone-home. The only network calls
  are to the merchant you asked for and the RPC endpoints you configured.
- **Same-chain only.** It pays on a network the merchant offered and you can sign for. It will not
  bridge or swap behind your back; if you can't pay, you get a typed `InsufficientLiquidityError`.

## Install

```bash
pip install tx402            # core: protocol codec + HTTP transport
pip install "tx402[evm]"     # + Base / EVM signing
pip install "tx402[svm]"     # + Solana signing
pip install "tx402[all]"     # everything
```

Requires Python 3.10+.

## Status

Pre-alpha. Targeting Base and Solana for the first release, with a TypeScript SDK
([`tx402` on npm](https://www.npmjs.com/package/tx402)) at behavioral parity — both are
validated against the same language-neutral conformance fixtures.

## License

Apache-2.0
