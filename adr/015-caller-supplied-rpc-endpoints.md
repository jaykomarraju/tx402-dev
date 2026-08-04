# ADR-015 — Caller-supplied RPC endpoints (`routing.rpcOverrides`)

**Status:** Accepted · **extends `SPEC.md` §4.3's configuration schema; changes no MUST**

Closes the tooling half of PLAN.md open item **O35**.

## Context

RPC endpoints reach the SDK exactly one way: the Ed25519-signed release manifest (SPEC §5.4)
carries `rpcUrls` per network, and `PolicyEngine` resolves a candidate's network through it.
SPEC §4.3 lets a caller replace the whole `manifest`, but its signature is verified at
construction against the trusted keys compiled into the package — so in practice a caller
cannot supply one, because they do not hold a release key. Nor should they.

The result is that **the endpoint list is not configurable at all**, and the manifest ships
keyless public endpoints because those are the only ones that can be published to every
installation. A keyless public endpoint has a per-IP quota.

That stopped being theoretical at S12. T-019 requires 50 Base Sepolia and 50 Solana Devnet
paid calls. The Base leg delivered 50/50. The Solana leg delivered **8**, then failed every
remaining call: each Solana payment costs five Devnet RPC requests, and both manifest
endpoints begin returning 429 after roughly forty requests from one address. Pacing at 600 ms
and at 2 000 ms produced the identical cutoff, which rules out a rate limit and identifies a
quota. tx402's own behaviour was correct throughout — it failed over, opened both circuits,
and refused to sign — so the assertions were deliberately not weakened.

An operator running at any volume has a keyed endpoint. They had no way to tell tx402 about
it.

## Decision

`routing.rpcOverrides` is a new optional configuration member:

```ts
routing: {
  rpcOverrides: {
    "solana:devnet": ["https://solana-devnet.g.alchemy.com/v2/<key>"],
  },
}
```

Keyed by CAIP-2 identifier or alias. The value **replaces `rpcUrls` for that network and
nothing else.**

Rules, enforced at construction:

1. The key is resolved through the manifest, exactly as `routing.preferNetworks` is. An
   unknown or misspelled network is a `ConfigurationError`, not an override that silently
   never applies — the failure mode worth designing against is an operator who believes
   their keyed endpoint is in use while every read still goes to the public one.
2. An empty list is invalid. "Override with nothing" is a mistake, not a request to fall
   back.
3. Each entry must parse as a URL and must be `https:`, except on `localhost`, `127.0.0.1`,
   and `[::1]`, where `http:` is allowed for a local validator or a stub. An RPC endpoint
   carries its API key in the path or query often enough that plaintext would leak it.
4. Nothing else about the network is overridable. Which networks exist, which assets they
   carry, a token's address, and a token's decimals all still come from the signed document.

## Why this does not weaken the manifest

The manifest signature exists so that a merchant, a compromised dependency, or a network
attacker cannot redirect tx402's balance reads to an endpoint that lies. An override is none
of those parties: it is the process owner, configuring their own client, in their own source,
in a diff a reviewer can see. A caller who can pass `rpcOverrides` can already pass a signer.

More importantly, the property the signature protects is **not** enforced by the signature
alone. SPEC §7.1 requires the chain ID returned by RPC to equal the candidate's CAIP-2 chain
ID before signing, on the same endpoint that served the balance, on every read; SPEC §7.2
requires the same of Solana's genesis hash. Those checks run against **whatever endpoint is
used**. So an override pointing at the wrong chain opens that endpoint's circuit and moves on
— it cannot produce a payment on a network the caller did not allow.

The worst an override can do is make tx402 unable to read a balance, which surfaces as a
typed `TransportError` and no signature. That is the same failure a dead manifest endpoint
produces, and it is already handled.

## Alternatives rejected

**Add the keyed endpoint to the signed manifest.** It would have to be published to every
installation, which is precisely what a keyed endpoint must not be.

**Let the test suite construct a manifest and sign it with a test key trusted in test
builds.** This makes the trusted-key set differ between the tested artifact and the shipped
one, so the thing proven green is not the thing published. Rejected on that alone.

**An environment variable read inside the SDK.** Rejected: library code that reads the
environment behind its caller's back is exactly the "silent fallback" SPEC §15 forbids, and
it would be invisible in a configuration review. The suites read the environment and pass the
value in explicitly; the SDK never does.

**Scope it to tests only.** The need is not a test need. An operator hitting a public quota
in production has the identical problem, and a test-only hook would mean the release run
exercises a code path users cannot reach.

## Consequences

- SPEC §4.3's table gains a row. No MUST or MUST NOT changes; this is additive, and a client
  that sets nothing behaves exactly as before.
- Both SDKs implement it, validated identically, because a configuration option that exists
  in one language is a parity break (ADR-005).
- The live and volume suites take an override from `TX402_SOLANA_DEVNET_RPC_URL` /
  `TX402_BASE_SEPOLIA_RPC_URL` when set, so T-019 can be claimed against an endpoint with
  adequate quota rather than being decided by the signed manifest.
- Documented in the configuration reference alongside the warning that an override is trusted
  to the same degree as the manifest for availability, and to no degree at all for chain
  identity, which is still proven on every read.
