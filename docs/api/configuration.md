# Configuration semantics frozen at M0

`createTx402Client` and its Python counterpart land in M1 (session S3). Three configuration
fields had their _meaning_ settled earlier, at M0, because each depends on something the
protocol or the manifest fixes rather than on the client's own implementation. They are
recorded here so the behavior is not rediscovered — or quietly re-invented — when the
config surface is written.

The full field table is SPEC §4.3. This page covers only what M0 changed or pinned.

---

## `routing.maxQuoteAgeMs` — conditional, and inert for standard v2 challenges

**Default:** `5000` · **SPEC §4.3, §6.3 step 12** · **ADR-010 decision 3**

SPEC describes this as "Reject older `PaymentRequired` timestamps **when present**", and
SPEC §6.3 step 12 likewise says "when defined by protocol".

> **Upstream x402 v2 `PaymentRequired` carries no timestamp.**

The verified shape at `@x402/core` 2.20.0 is:

```ts
type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo; // { url, description?, mimeType?, serviceName?, tags?, iconUrl? }
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};
```

There is no `issuedAt`, no `timestamp`, and no `expiresAt`. The only place a challenge
timestamp can appear is inside a requirement's scheme-specific `extra` object.

So the check is implemented, and it is **conditional**: it looks for a timestamp in `extra`,
and where none is present — which is every standard v2 challenge — it does nothing.

**What this means in practice.** The default of `5000` is not an active protection against
stale quotes. Setting it lower does not tighten anything, and the field being non-zero should
not be read as evidence that challenge freshness is being enforced. What _does_ bound the
window is the authorization lifetime: `min(60s, maxTimeoutSeconds)`, never exceeding the
merchant's own bound (SPEC §6.6).

The field is kept rather than removed for two reasons: SPEC §4.3 defines it, and a scheme
that starts putting a timestamp in `extra` gets the check for free.

---

## `policy.allowedNetworks` and `routing.preferNetworks` — aliases in, canonical out

**SPEC §4.1, §4.3, §7.2** · **ADR-010 decision 4**

SPEC §4.1's example writes `"solana:mainnet"`. Upstream never emits that. Solana CAIP-2
identifiers are genesis-hash based:

| Cluster | Canonical CAIP-2                          | Alias            |
| :------ | :---------------------------------------- | :--------------- |
| Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `solana:mainnet` |
| Devnet  | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `solana:devnet`  |

Configuration accepts **either form**. The alias map lives in the signed release manifest, so
it is as tamper-evident as the network list itself, and a manifest whose alias shadows a real
network is rejected at construction.

Everything downstream — policy matching, route selection, health indexing, diagnostics —
keys on the **canonical** identifier. The alias is display and input only.

This is a correctness rule rather than cosmetics: keying health or policy on an alias would
silently fail to match a merchant's canonical offer, and the failure would look like "the
merchant does not support Solana" rather than like a bug.

An identifier that is neither a declared network nor a declared alias is a `ConfigurationError`
at construction, not a value passed through unresolved. Passing it through would let policy
accept a network the SDK cannot pay on.

---

## `manifest` — verified at construction, offline, against compiled-in keys

**SPEC §4.3, §5.4** · **ADR-012**

Defaults to the signed manifest bundled with the build. A caller-supplied manifest is
verified on identical terms; there is no "trust me" mode.

Verification is offline and synchronous, and failure **prevents construction** — it is never
downgraded to a warning, because everything downstream treats manifest contents as
authoritative. Rejection reasons are stable identifiers (`expired`, `signature-mismatch`,
`unknown-key-id`, …) reported in the error's `details.reason`.

Two consequences worth knowing before S3:

- **Expiry is real.** The bundled manifest stops verifying on **2027-08-02**, at which point
  client construction fails until it is re-issued. See
  [the manifest runbook](../operations/release-manifest.md).
- **`requiredNetworks` is not applied by default.** SPEC §5.4's four-network requirement binds
  the _bundled_ manifest, which a test asserts directly. A caller-supplied manifest may
  legitimately declare a single network — a local integration fixture, for instance — so
  verification requires nothing unless asked.

---

## `signers` — abstractions only (SEC-001)

`signers.evm` takes anything satisfying SPEC §7.1's `EvmSigner`: a `kind`, an async
`getAddress()`, and `signTypedData(request)`. The core client never accepts a private key, and
there is no environment-variable fallback — SPEC §15 forbids silently substituting an
environment key for a configured signer.

The address is resolved on **first use** and cached per signer object, not at construction:
`createTx402Client` validates synchronously (SPEC §4.1) and cannot await an async lookup. A failed
lookup is not cached, so a transient KMS outage does not disable a signer for the life of the
process. ADR-010 decision 5a records this.

Chain adapters load lazily. `signers.evm` alone is enough — importing `tx402/evm` by hand is only
necessary to build a signer or inspect a plan. A configured signer for a family whose adapter does
not exist yet (Solana, until M4) produces `UnsupportedSchemeError` listing the networks that were
offered, never a silent skip.

The convenience adapter for a raw key lives behind its own import:

```ts
import { privateKeyToEvmSigner } from "tx402/signers";
```

It exists for development and for dedicated low-balance wallets. Prefer a KMS, a hardware wallet,
or a remote signing service — SPEC §9.1 lists prompt injection extracting a wallet key as a live
threat for the agent runtimes this SDK targets, and a key in process memory is a key an in-process
compromise can read.

---

## `timeouts` — the caller's own deadline is never shortened

| Field                       | Default                 | Behaviour                                                                                                                                            |
| :-------------------------- | :---------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeouts.initialRequestMs` | absent                  | No SDK deadline. The caller's transport or `AbortSignal` governs. Supplying one adds a deadline **alongside** any caller signal, never replacing it. |
| `timeouts.paymentRetryMs`   | `10000`, minimum `1000` | Covers the signature-bearing attempt.                                                                                                                |

A paid retry that hits its deadline is **ambiguous**, not failed: the signature was already
transmitted, so `AmbiguousPaymentError` is raised and the reservation is retained until its
120-second TTL (SPEC §6.7). Setting this very low does not make failures cleaner — it makes
ambiguous outcomes more likely.

---

## `disableRequestIdHeader`

Omits `X-TX402-REQUEST-ID` from the paid retry. The header carries a UUIDv7 and no payment meaning
(SPEC §6.7); turn it off for merchants that reject unknown headers. The caller's own
`Idempotency-Key` is always preserved and is never synthesized — merchant semantics are unknown, so
inventing one would be guessing.

---

## Not yet frozen

Everything else in SPEC §4.3 — `policy.maxPerRequest`, `policy.maxPerHour`,
`policy.allowedDomains`, `policy.maxPaidAttempts`, `spendStore`, `logger`, `clock` — is
implemented at M1/M2 with the semantics SPEC §4.3 already states. Nothing about them changed at M0.
`routing.preferNetworks` is not implemented yet: M3 selects the first viable requirement in the
merchant's own order, and the deterministic planner that consumes a preference lands at M5.
