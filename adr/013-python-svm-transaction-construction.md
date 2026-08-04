# ADR-013 — Python SVM transaction construction

**Status:** Accepted · **narrows `SPEC.md` §7.2 and Appendix A for the Python SDK only**

## Context

SPEC §7.2 says v0.1 "supports native USDC SPL token payment requirements **accepted by the
pinned x402 SVM scheme**", and Appendix A lists the "Upstream EVM and SVM x402 packages pinned
by release lockfile" as the source of "authorization creation and serialization". The
TypeScript SDK does exactly that: `packages/tx402/src/solana/adapter.ts` hands a
`TransactionPartialSigner` to `@x402/svm`'s `ExactSvmScheme` and lets upstream compile the
transaction.

PyPI `x402` 2.17's `ExactSvmScheme` cannot be used the same way. Two independent facts block
it, and either alone would be sufficient.

### 1. Its signer contract is a raw key pair, which SEC-001 forbids

`x402/mechanisms/svm/signer.py` defines `ClientSvmSigner` with a **`keypair: Keypair`**
property, and `x402/mechanisms/svm/exact/client.py` signs with:

```python
client_signature = self._signer.keypair.sign_message(msg_bytes_with_version)
```

The scheme does not ask a signer to sign; it takes the signer's private key and signs on its
behalf. That is incompatible with two normative requirements at once:

- **SEC-001** — "Core APIs MUST accept signer abstractions, not raw private key strings."
- **SPEC §7.2** — "`SolanaSigner` MUST expose public key and sign the upstream-defined
  transaction/message bytes **without exporting secret material**."

A shim cannot satisfy both: to hand upstream a `keypair` object, tx402 would have to hold one,
which is precisely what a hardware wallet, a KMS, or a remote signing service cannot provide.
The TypeScript path has no such problem — `@x402/svm` accepts `@solana/kit`'s
`TransactionSigner`, an interface, which is why ADR-010 decision 5 could bridge it with an
adapter.

### 2. The module cannot be imported against the resolved dependency set

`x402/mechanisms/svm/exact/client.py` begins with `from solana.rpc.api import Client`.
`solana` 0.40 — the version the lockfile resolves under `x402[svm]`'s `solana>=0.36.0` — no
longer ships `solana.rpc.api`. Importing the scheme raises `ImportError` before any of the
above matters. tx402 would have no upstream SVM path available even if the signer contract
fitted.

## Decision

**The Python SDK compiles the exact-scheme SPL transfer itself, from `solders` primitives.**
`tx402/solana.py` builds the `MessageV0`, validates it, asks the caller's `SolanaSigner` for a
signature over the message bytes, and assembles the partially-signed `VersionedTransaction`.

Three constraints bound what this permits.

### 1. No cryptography is re-implemented

SPEC §3.2 forbids implementing secp256k1, Ed25519, Keccak, SHA-256, or base58 from scratch.
None of it is. base58 decoding, Ed25519 signature handling, SHA-256, and program-derived-address
derivation all come from **`solders`** — the same audited library upstream itself builds on, and
now a directly declared dependency of the `tx402[svm]` extra rather than a transitive one.
tx402 contributes instruction layout and byte assembly, not primitives.

### 2. The wire format is upstream's, byte for byte

The compiled transaction must be indistinguishable from one `ExactSvmScheme` would have
produced, because a facilitator verifies it against the same rules. tx402 reproduces:

| Element                | Value                                                                               |
| :--------------------- | :---------------------------------------------------------------------------------- |
| Instruction order      | `SetComputeUnitLimit`, `SetComputeUnitPrice`, `TransferChecked`, memo               |
| Compute-budget data    | `[2] + u32 LE 20000`, `[3] + u64 LE 1`                                              |
| `TransferChecked` data | `[12] + u64 LE amount + u8 decimals`                                                |
| Transfer accounts      | `[source ATA, mint, destination ATA, authority]`, authority signer, non-writable    |
| Memo                   | merchant `extra.memo`, else `hexlify(urandom(16))`, capped at 256 bytes             |
| Fee payer              | `extra.feePayer`, at signature slot 0; the buyer's authority signature is slot 1    |
| ATA derivation         | `[owner, token_program, mint]` under `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |

The four frozen `svm.authorization-plan` vectors already pin the derived ATAs, the lifetime
clamp, the required fee payer, and the Token-2022 exclusion across both languages, so a drift
in the plan fails conformance in Python before it can reach a wire format.

### 3. tx402 validates what it built, by re-reading the wire bytes

`_validate_transaction` decodes the serialized message rather than inspecting the builder's
own objects, and checks the fee payer, blockhash, instruction count, every program ID, the
transfer's source, mint, destination, authority, integer amount and decimals, the memo, and
the 1232-byte wire limit — all **before** the caller's signer is invoked. Validating the
decoded bytes is the only arrangement in which a construction bug fails a test rather than
agreeing with itself.

## Consequences

- **No SPEC MUST is weakened; one is made reachable.** SPEC §7.2's "without exporting secret
  material" and SEC-001 are satisfiable in Python only under this decision. §7.2's "accepted by
  the pinned x402 SVM scheme" is narrowed for Python from _produced by_ to _acceptable to_, and
  the byte-level table above is what makes that a distinction without a difference on the wire.
- **The asymmetry between the two SDKs is deliberate and bounded.** TypeScript still delegates
  to `@x402/svm`. Both are held to the same frozen fixtures and the same T-016 parity gate, so
  the divergence is in _how_ the transaction is produced, never in _what_ is produced.
- **Upstream moves must be re-checked here specifically** (PLAN.md open item O6). If a future
  PyPI `x402` accepts a signing interface rather than a key pair, and imports cleanly, this ADR
  should be revisited: delegating is preferable when it is possible.
- **`solders` is a declared dependency of the `svm` extra**, pinned `>=0.27,<1`. It is not on
  the core install path: `tx402/__init__.py` deliberately does not re-export anything from
  `tx402.solana`, and a package-contract test asserts that `import tx402` loads no chain
  library.
