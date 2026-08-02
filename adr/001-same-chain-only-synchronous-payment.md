# ADR-001 — Same-chain-only synchronous payment

**Status:** Accepted · transcribed from `SPEC.md` §2 (ADR-001)

## Context

x402 is designed around a short HTTP challenge–response loop. Cross-chain transfer introduces
quoting, source-chain execution, finality, solver, relayer, and destination-chain dependencies that
cannot provide deterministic sub-second completion inside an HTTP retry.

## Decision

v0.1 **MUST** pay only on a network that is simultaneously:

1. explicitly offered by the merchant in the `PAYMENT-REQUIRED` challenge,
2. directly supported by a configured signer, and
3. backed by a sufficient native USDC balance.

No bridge and no swap may execute inside `fetch()`.

## Consequences

- Base and Solana are the production networks for v0.1.
- Wormhole and CCTP integration is deferred behind the `ChainLiquidityProvider` extension point
  (`SPEC.md` §7.3) and **cannot** be enabled in v0.1.
- When no offered network is payable, the SDK raises `InsufficientLiquidityError` rather than
  attempting to acquire funds.
