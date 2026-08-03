# Base Sepolia test wallet — funding and running the live suite

The Base adapter's automated suite is fully deterministic and needs no wallet: it runs against a
local JSON-RPC stub (`tools/evm-rpc-stub`) and the local test merchant. This runbook is for the
**opt-in live test**, which SPEC §12.1 requires before release and which PLAN.md tracks as open
item **O2**.

## 1. Create a dedicated wallet

SPEC §13 is specific about this: "dedicated low-balance wallets funded only for automated Base
Sepolia and Solana Devnet tests". Do not reuse a wallet that holds anything you would mind losing,
and do not reuse one that has ever touched mainnet — a testnet key that leaks is only harmless if
it controls nothing else.

```sh
# Any tool that produces a secp256k1 key works. This one uses viem, already in the workspace.
node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');
const k=generatePrivateKey();console.log('key    ', k);console.log('address', privateKeyToAccount(k).address)"
```

Store the key in a password manager or a secret manager. Never commit it, never pass it as a
command-line flag (SPEC §11 forbids that for the CLI), and never paste it into an issue.

## 2. Fund it

Two balances are needed, both small:

| What              | Why                                                    | Suggested |
| :---------------- | :----------------------------------------------------- | :-------- |
| Sepolia ETH       | Not spent by tx402 — the buyer never broadcasts a      | 0.01 ETH  |
|                   | transaction — but useful for any manual on-chain check |           |
| Base Sepolia USDC | The asset the exact scheme authorizes                  | 5 USDC    |

- Base Sepolia ETH: <https://www.alchemy.com/faucets/base-sepolia> or the Coinbase faucet.
- Base Sepolia USDC: <https://faucet.circle.com> (select Base Sepolia).

The USDC contract the SDK will use is the one in the signed manifest —
`0x036CbD53842c5426634e7929541eC2318f3dCF7e` — not whatever a faucet page happens to name. If a
faucet sends a different token the balance read will simply report zero.

## 3. Run the live suite

```sh
TX402_BASE_SEPOLIA_PRIVATE_KEY=0x… pnpm --filter tx402 exec vitest run test/base-sepolia.live.test.ts
```

Without the environment variable the file is skipped, which is why ordinary CI stays green with no
wallet configured.

What it exercises for real: chain identity against the manifest's published Base Sepolia RPC
endpoints, a USDC balance read for your address, the full policy → reserve → sign path, and a real
EIP-712 signature from your key. The merchant half is played by the local test merchant, which
validates the authorization it receives.

What it cannot exercise: settlement. ADR-002 puts `/verify` and `/settle` on the merchant, so the
buyer SDK has no settlement path to test. To close that loop, point the same client at a real x402
merchant:

```sh
TX402_BASE_SEPOLIA_PRIVATE_KEY=0x… \
TX402_LIVE_MERCHANT_URL=https://some-merchant.example/paid-resource \
  pnpm --filter tx402 exec vitest run test/base-sepolia.live.test.ts
```

## 4. Before release

SPEC §12.4 requires the public testnet smoke suite to pass **twice from clean environments**, and
SPEC §12.2's T-019 asks for 50 Base Sepolia and 50 Solana Devnet calls with zero SDK-caused
failures. Both land at M8 (session S12) and both need this wallet funded, so keep it topped up
rather than draining it after a single run.

## Troubleshooting

| Symptom                                            | Cause                                                                                        |
| :------------------------------------------------- | :------------------------------------------------------------------------------------------- |
| `TX402_LIQUIDITY` with `available: "0"`            | USDC is on the wrong network, or a faucet sent a different token contract                    |
| `TX402_TRANSPORT` with `causeCategory: "timeout"`  | Public RPC is slow; the per-provider budget is 600 ms (SPEC §6.4)                            |
| `TX402_TRANSPORT` with `chain-id-mismatch`         | An RPC endpoint answered for another chain — SPEC §7.1 refuses to trust it                   |
| `TX402_PAYMENT_REQUIRED_INVALID` `eip712-domain-…` | The merchant omitted `extra.name`/`extra.version`, or named a version the token does not use |
