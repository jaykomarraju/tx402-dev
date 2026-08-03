# ADR-010 — Upstream envelope reconciliation

**Status:** Accepted · **clarifies `SPEC.md`** §5.1, §6.2, §7.1, §7.2 and `routing.maxQuoteAgeMs` in §4.3

## Context

`SPEC.md` §5 states that its schemas are tx402's _internal normalized_ representation and that the
real wire fields "MUST be implemented from the pinned protocol dependency and conformance fixtures."
It does not enumerate what those upstream fields actually are.

The published packages were downloaded and read at planning time — `@x402/core`, `@x402/evm`, and
`@x402/svm` at **2.20.0**, and PyPI `x402` at **2.17.0**. Several concrete gaps exist between what
SPEC assumes and what upstream ships. Each is resolved below so the ambiguity is not rediscovered
during implementation.

Upstream's actual v2 shape:

```ts
type PaymentRequirements = {
  scheme: string;
  network: Network;
  asset: string;
  amount: string; // NOT "amountAtomic"
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};
type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo; // { url, description?, mimeType?, serviceName?, tags?, iconUrl? }
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};
```

## Decision

### 1. Field naming — normalize at the decoder boundary

Upstream `amount` maps to tx402's `amountAtomic`; upstream `accepts[]` maps to tx402's
`requirements[]`. SPEC §5.1/§5.2 names are retained as the internal contract and as the shape used
in conformance fixtures and diagnostics. Mapping happens once, in the decoder. No behavior change.

### 2. Method binding is local, not challenge-derived

Upstream `resource` has **no `method` field**. SPEC §6.2 step 5 ("Bind the challenge to the original
URL and method. Reject mismatches") is implemented as:

- **URL:** validate `resource.url`'s normalized origin against the origin actually requested.
  A mismatch is `InvalidPaymentRequiredError`.
- **Method:** bind to the method tx402 itself issued. tx402 sent the request, so it knows the
  method with certainty; there is nothing to cross-check against and nothing to spoof.

`NormalizedPaymentRequired.resource.method` is therefore **populated by tx402**, not parsed.

### 3. `routing.maxQuoteAgeMs` is conditional and inert for standard v2

Upstream `PaymentRequired` carries **no timestamp**. SPEC §4.3 already hedges the field as
"Reject older PaymentRequired timestamps **when present**" and §6.3 step 12 likewise says "when
defined by protocol". The check is implemented, looks for a timestamp only in `extra`, and is a
**no-op for standard v2 challenges**. This must be documented on the config field so the default of
5000 ms is not mistaken for an active protection.

### 4. Solana CAIP-2 identifiers are genesis-hash based; `solana:mainnet` is an alias

Upstream uses full genesis-hash CAIP-2 identifiers:

| Cluster | Canonical CAIP-2                          |
| :------ | :---------------------------------------- |
| Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| Devnet  | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |
| Testnet | `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z` |

`solana:mainnet` — as it appears in the SPEC §4.1 config example — is an **alias**, exactly as
SPEC §7.2 anticipated. The signed release manifest carries canonical IDs plus an alias map.
`policy.allowedNetworks`, `routing.preferNetworks`, and the CLI `--network` flag accept **either
form** and normalize to canonical before any comparison. Route matching, health indexing, and
diagnostics all key on the **canonical** identifier; the alias is display-only.

### 5. Signer interfaces need thin adapters

SPEC §7.1/§7.2 define tx402's public signer contracts. Upstream expects different shapes:

| tx402 public contract (SPEC)                        | Upstream expects                                             | Adapter                                                                                    |
| :-------------------------------------------------- | :----------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| `EvmSigner.getAddress(): Promise<0x…>`              | `ClientEvmSigner.address` — a **synchronous property**       | Resolve the address once at client construction, expose it as the property upstream reads. |
| `EvmSigner.signTypedData(req)`                      | `signTypedData({domain, types, primaryType, message})`       | Direct pass-through.                                                                       |
| `SolanaSigner.getPublicKey()` / `signTransaction()` | `ClientSvmSigner` **is** `@solana/kit`'s `TransactionSigner` | Wrap tx402's interface into a `TransactionSigner`.                                         |

tx402's SPEC-defined interfaces remain the **public** contract; the adapters are internal.
`@solana/kit` (upstream peer dependency `>=5.1.0`) is an optional peer of tx402, reachable only via
the `tx402/solana` entry point.

Upstream's optional `ClientEvmSigner` capabilities — `readContract`, `signTransaction`,
`getTransactionCount`, `estimateFeesPerGas` — exist to support EIP-2612 / ERC-20 approval gas
sponsoring. v0.1 supports USDC via the exact scheme only, so these are **not** required; they are
forwarded if the caller's signer happens to provide them, and their absence is never an error.

### 6. tx402 owns the request loop; upstream owns envelope and signing

Upstream `x402Client` already exposes `policies: PaymentPolicy[]`, a `paymentRequirementsSelector`,
and client hooks. Those all run **inside** upstream's payload-creation call — after tx402 must
already have reserved budget (SEC-002) and chosen a route. They are therefore the wrong seam.

tx402 implements the SPEC §6 state machine itself and calls upstream at exactly two points:

- **Envelope codec** — `@x402/core/http`: `decodePaymentRequiredHeader`,
  `encodePaymentSignatureHeader`, `decodePaymentResponseHeader`.
- **Payload creation** — `ExactEvmScheme` / `ExactSvmScheme` `.createPaymentPayload(2, requirement)`.

tx402 pre-selects **one** requirement and hands upstream exactly that one, so upstream's default
"first available" selector never has a choice to make. tx402 does **not** register policies or
selectors with upstream.

### 7. Python sync transport is tx402's own

PyPI `x402` 2.17.0 ships an **async-only** httpx integration (`x402AsyncTransport`,
`AsyncBaseTransport`); its only sync HTTP integration is a `requests` `HTTPAdapter`. SPEC §4.2
requires a **synchronous** `Tx402Client` on an httpx-compatible transport. tx402 implements its own
`httpx.BaseTransport` (sync) and `httpx.AsyncBaseTransport` (async). This follows anyway from
decision 6 — tx402 owns the loop in both languages.

### 5a. Amendment (S5) — the address is resolved on first use, not at construction

Decision 5 said the address is resolved "once at client construction". That is not reachable:
SPEC §4.1 requires `createTx402Client(config)` to validate configuration **synchronously** and return
a client, while `EvmSigner.getAddress()` is asynchronous by design — a KMS, a hardware wallet, or a
remote signing service cannot answer synchronously, which is why SPEC §7.1 declares it returning a
promise.

The resolution therefore happens on **first use** and is memoized per signer object for that
object's lifetime (`packages/tx402/src/evm/signer.ts`). A failed lookup is not cached, so a transient
KMS outage does not disable a signer for the life of the process. What decision 5 was actually
securing is unchanged: upstream still reads a plain synchronous `address` property, and it is read
exactly once per signer no matter how many payments follow.

### 5b. What the adapter adds beyond shape bridging

The adapter turned out to be the natural place to enforce SPEC §6.6, so it does two things upstream
cannot:

- **Plan enforcement.** Every field of the EIP-712 message upstream produces is compared against the
  requirement policy approved — chain ID, verifying contract, token domain, payer, recipient, amount,
  `validAfter`, `validBefore`, and nonce length — before the caller's signer is invoked. A mismatch
  raises `SignerError` and no signature is requested. This is what makes "the authorization lifetime
  must never exceed the merchant bound" an assertion rather than a comment.
- **Presentation.** SPEC §6.6 requires the request presented to an external signer to carry a
  human-readable domain, asset, atomic amount, decimal amount, recipient, network, expiry, and
  request hash. Upstream's `ClientEvmSigner` contract has no room for any of that, so tx402's
  `EvmTypedDataRequest` carries a `presentation` member alongside the typed data, and the adapter
  populates it from data already validated against the signed manifest.

The lifetime bound itself is applied by handing upstream a requirement whose `maxTimeoutSeconds` is
already clamped to `min(60, merchant bound)`. The **offered** requirement still goes on the wire as
`accepted`, unmodified, so a facilitator comparing the payload against the merchant's own offer sees
exactly what the merchant published.

## Consequences

- No SPEC **MUST** is weakened. Every item above resolves an ambiguity or supplies a fact SPEC
  deferred to "the pinned protocol dependency".
- Upstream versions are pinned in lockfiles (`@x402/*` `~2.20.0`, PyPI `x402` `2.17.*`). Per
  SPEC §15, any upgrade replays the full conformance suite; decisions 1–5 above are re-verified
  against the new version as part of that replay. Open item **O6** tracks this.
- The canonical-vs-alias network rule (decision 4) is a correctness requirement, not cosmetics:
  keying health or policy on the alias would silently fail to match a merchant's canonical offer.
