<div align="center">

# tx402

**A resilient, non-custodial buyer-side SDK for the x402 HTTP payment protocol — in TypeScript and Python.**

Wrap your HTTP client. Get spend caps that are enforced before a key is touched, deterministic
payment routing across whatever chains the merchant offered, and one signature per payment.

[![npm](https://img.shields.io/npm/v/tx402?label=npm%20tx402&color=cb3837)](https://www.npmjs.com/package/tx402)
[![PyPI](https://img.shields.io/pypi/v/tx402?label=PyPI%20tx402&color=3775a9)](https://pypi.org/project/tx402/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![x402](https://img.shields.io/badge/x402-v2-6d28d9)](https://github.com/coinbase/x402)

[Documentation](https://tx402.dev/docs) · [Quickstart](https://tx402.dev/docs/start/quickstart/) ·
[Error reference](https://tx402.dev/docs/reference/errors/) · [Security policy](SECURITY.md) ·
[Contributing](CONTRIBUTING.md)

</div>

> [!IMPORTANT]
> **`0.1.0` is not released yet.** The `0.0.0` on npm and PyPI is an inert name placeholder — it
> contains no working code. Both SDKs are feature-complete and at behavioural parity, and the
> project is in pre-publication review. Do not depend on `0.0.0`.

---

## The problem

An agent running a fifty-step workflow cannot afford to have step 45 die because the merchant
wanted USDC on a chain it wasn't configured for, or because an RPC endpoint went dark. The usual
answer is ~100 lines of bespoke glue per integration: parse the `402`, hope you can pay, sign
something, retry, and discover afterwards whether money moved.

The protocol layer is settled — x402 v2 exists and works. The gap is everything around it:
**resilience, spend control, and knowing what happened.**

## Install

```bash
npm install tx402                # TypeScript / Node 20+
pip install "tx402[evm]"         # Python 3.10+  (or tx402[svm], tx402[all])
```

Chain support is optional in both languages — subpath exports (`tx402/evm`, `tx402/solana`) in
TypeScript, extras in Python. **Importing `tx402` loads no chain library in either language**, and
a test asserts it in a subprocess so the property cannot rot.

## Sixty seconds

<table>
<tr><th>TypeScript</th><th>Python</th></tr>
<tr valign="top"><td>

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

const res = await tx402.fetch(url);
```

</td><td>

```python
from tx402 import Policy, Tx402Client

with Tx402Client(
    evm_signer=evm,
    solana_signer=svm,
    policy=Policy(
        max_per_request="0.50 USDC",
        max_per_hour="10.00 USDC",
        allowed_networks=["eip155:8453", "solana:mainnet"],
    ),
) as tx402:
    res = tx402.get(url)
```

</td></tr>
</table>

That is the whole integration. `res` is a normal response; if the resource cost money, it was paid
for. If it could not be paid for, you get a **typed** error that tells you which of fifteen things
went wrong — not a bare `402`.

Or, without writing any code at all:

```bash
npx tx402 call <merchant-url> --max-spend "0.10 USDC" --dry-run   # never invokes a signer
npx tx402 call <merchant-url> --max-spend "0.10 USDC" --json
```

## What happens on a 402

```
  request ──▶ 402 PAYMENT-REQUIRED
                │
                ├─ 1. decode strictly        base64 strict · ≤64 KiB · depth ≤16 · no duplicate keys
                ├─ 2. normalize + hash       resource origin checked against the URL you asked for
                ├─ 3. POLICY                 domain → network → scheme/asset → per-request → rolling hour
                ├─ 4. plan routes            every offered chain probed concurrently, then ranked
                ├─ 5. RESERVE                atomically, from your local ledger
                ├─ 6. sign                   ← the first time a key is touched
                ├─ 7. retry once             exactly one PAYMENT-SIGNATURE
                └─ 8. read PAYMENT-RESPONSE  → commit the reservation
```

**Steps 3 and 5 happening before step 6 is the property the entire design is built around.** A
budget check that runs after signing is not a budget check.

Route selection is a total ordering — viability, open circuit, your preference, buyer fee, health
score, observed latency, requirement index — so identical inputs and identical health state produce
an identical choice, every time. Not "whichever RPC answered first".

## Design commitments

These are load-bearing, not aspirations. Each one is enforced by a test, a gate, or a type.

|                                     |                                                                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Non-custodial**                   | The core API accepts signer _abstractions_. It never takes a private key string, and there is no CLI flag that carries one. Convenience key adapters live in an isolated `tx402/signers` entry you have to reach for on purpose. |
| **Policy before signature**         | Caps, allowlists and the budget reservation are evaluated and committed before any signer call. Not a convention — a pure disposition table the request path consults.                                                           |
| **Integer money**                   | Every amount is an integer in atomic units. A JS `number` or a Python `float` is _rejected_, never coerced. A cap that rounds is not a cap.                                                                                      |
| **No backend**                      | No tx402-operated service, no telemetry, no phone-home. The only hosts contacted are the merchant you named and the RPC endpoints in the signed manifest or your config.                                                         |
| **The buyer never settles**         | tx402 does not call a facilitator's `/verify` or `/settle`, and does not broadcast your transaction. The merchant owns settlement.                                                                                               |
| **Same-chain only**                 | It pays on a network the merchant offered _and_ you can sign for. It will never bridge or swap behind your back — you get `InsufficientLiquidityError` instead.                                                                  |
| **Nothing sensitive is logged**     | Signatures, keys and authorization payloads never reach the diagnostic stream. Proven by seeding real secrets into every input and searching the whole serialised event stream for each one.                                     |
| **Ambiguity is a distinct outcome** | If a request times out _after_ the signature went out, money may have moved. That is `AmbiguousPaymentError` with the reservation retained — never a silent retry.                                                               |

## Networks

| Network        | CAIP-2                                    | Asset | Status                                            |
| -------------- | ----------------------------------------- | ----- | ------------------------------------------------- |
| Base Mainnet   | `eip155:8453`                             | USDC  | In the signed manifest                            |
| Base Sepolia   | `eip155:84532`                            | USDC  | Testnet — live suite green, real settled payments |
| Solana Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | USDC  | In the signed manifest                            |
| Solana Devnet  | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | USDC  | Testnet — live suite green, real settled payments |

`solana:mainnet` and `solana:devnet` are accepted as aliases and normalised to the canonical
genesis-hash IDs. The network list and its RPC endpoints ship as an **Ed25519-signed manifest**
compiled into both packages; construction fails if the signature does not verify.

## Documentation

|                                                                  |                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| [Quickstart](https://tx402.dev/docs/start/quickstart/)           | Real settled testnet payment, no source reading    |
| [Request lifecycle](https://tx402.dev/docs/guides/lifecycle/)    | The state machine, end to end                      |
| [Spend policy](https://tx402.dev/docs/guides/policy/)            | Caps, allowlists, the ledger                       |
| [Routing & health](https://tx402.dev/docs/guides/routing/)       | How a route is chosen, and why it is deterministic |
| [CLI](https://tx402.dev/docs/guides/cli/)                        | Flags and exit codes                               |
| [Error reference](https://tx402.dev/docs/reference/errors/)      | All fifteen codes — generated from shipped source  |
| [Configuration](https://tx402.dev/docs/reference/configuration/) | Every option in both languages                     |
| [Key management](https://tx402.dev/docs/security/keys/)          | What to do instead of an environment variable      |

## Repository layout

```
packages/tx402/          npm "tx402"    — SDK + CLI (TypeScript, the reference implementation)
packages/tx402-python/   PyPI "tx402"   — SDK + CLI (Python, at behavioural parity)
core-spec/               language-neutral: JSON Schemas, 65 frozen conformance vectors,
                         and the signed release manifest. Neither SDK keeps a private copy.
docs/                    the documentation site (Astro Starlight)
examples/                runnable quickstart and dry-run, both languages
tools/                   size gate, manifest signer, conformance index, test merchant,
                         RPC stubs, fuzz + performance harnesses, supply-chain gates
adr/                     every architectural decision, including each deviation from SPEC.md
```

**The two SDKs are held together by files, not by intent.** All 65 conformance vectors execute in
both languages against the same normalized output, route ordering, error codes and money rule. The
release manifest is signed by the Node tool and verified by the Python SDK, so the canonical-JSON
encoding and the Ed25519 envelope are proven identical by the signature itself.

## Development

```bash
pnpm install
pnpm check                        # every gate, in the order CI runs them

cd packages/tx402-python
uv sync --all-extras
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q
```

`pnpm check` runs lint, format, types, the NUL-byte guard, the workflow linter, conformance index
integrity, the manifest signature, both test suites, the build, the size gate, and the docs site.
A gate is only evidence if it ran in the order and from the state CI uses — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the traps that rule exists because of.

Live testnet suites are opt-in and **skip silently** without credentials, which looks exactly like
a green run. Source `. tools/live-env.sh` first; it prints which variables resolved.

## Versioning and releases

Semantic versioning, with the 0.x caveat spelled out: see **[VERSIONING.md](VERSIONING.md)** for
the compatibility contract, what counts as a break, and the release process. Changes are recorded
in **[CHANGELOG.md](CHANGELOG.md)**.

## Security

Do not open a public issue for a vulnerability. Report it through
[GitHub Private Vulnerability Reporting](https://github.com/neogeeks/tx402/security/advisories/new).
Scope, response times, and the guarantees a report can be filed against are in
[SECURITY.md](SECURITY.md).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) leads with the three rules that actually get a PR rejected:
`SPEC.md` governs, the 65 conformance fixtures are frozen, and behavioural changes land in both
languages together. Participation is governed by the
[Contributor Covenant](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE).
