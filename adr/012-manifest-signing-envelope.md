# ADR-012 — Release manifest signing envelope

**Status:** Accepted · **concretizes `SPEC.md` §5.4; adds one Python runtime dependency**

## Context

`SPEC.md` §5.4 requires the release manifest to carry
`{"algorithm":"ed25519","keyId":"tx402-release-1","value":"base64"}`, and requires that
signature failure, expiry, an unknown key ID, a duplicate network, or invalid token metadata
prevent client construction. SPEC §0 makes the manifest the only channel through which chain
addresses, token addresses, and facilitator URLs may reach core logic.

What it does not say is **what bytes the signature covers**. A signature over "the manifest"
is not a specification: JSON has no canonical form, so `{"a":1,"b":2}` and `{"b":2,"a":1}`
are the same document and different bytes. Two implementations that each picked something
reasonable would produce manifests the other could not verify — and per ADR-005, the Python
SDK must verify manifests the TypeScript tooling signs.

Two further questions had to be settled before any signing could happen at all: how the
document reaches the SDK at runtime, and how Python performs Ed25519 verification.

## Decision

### 1. tx402 canonical JSON

A deterministic serialization, defined in full and frozen at M0:

1. Permitted types are object, array, string, integer, boolean, and null. Anything else — a
   float, `NaN`, `Infinity`, `undefined`, a `bigint`, a `Decimal`, a `datetime`, `bytes` — is
   **rejected**, never coerced.
2. Integers must satisfy `|n| <= 2^53 - 1`. Python's integers are unbounded and JavaScript's
   are not, so the narrower language sets the limit; without it a document could canonicalize
   in Python and silently round in TypeScript.
3. Object keys must be printable ASCII (U+0020–U+007E) and are sorted ascending. The ASCII
   restriction is what makes the sort unambiguous — JavaScript compares strings by UTF-16
   code unit and Python by code point, and the two disagree above the BMP.
4. Strings escape `"` and `\`, use the short forms for `\b \t \n \f \r`, and escape every
   other character outside U+0020–U+007E as lowercase `\uXXXX` per UTF-16 code unit. Output
   is therefore always pure ASCII.
5. No insignificant whitespace: `,` and `:` are bare separators.

Rules 3–5 make the output identical to Python's
`json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False)`,
which is how the Python implementation is written. The TypeScript implementation writes its
escaper by hand. Two genuinely independent code paths over one frozen contract, with the
`canonical-json.*` vectors pinning the output byte for byte in both.

Rule 1 rejects floats rather than specifying their formatting. Floating-point rendering
differs between languages in the general case, and the manifest has no legitimate use for a
fractional number — `decimals` and `chainId` are integers, and every amount is an atomic-unit
string per ADR-006.

### 2. Domain-separated signing input

```
signing_input = b"tx402-release-manifest/v1\n" || canonical_json(document without "signature")
```

The prefix means a signature produced over a tx402 manifest can never be replayed as a
signature over a different document the same key signs — a future conformance bundle, a
package attestation, anything. The `/v1` suffix means a change to the envelope invalidates
old signatures instead of silently reinterpreting them.

The `signature` member is **removed** rather than blanked. A placeholder value would have to
be agreed on by every implementation, and forgetting to strip it is a much quieter bug than a
missing key.

### 3. Verification order is normative

Both languages evaluate in exactly this order, because two implementations that reject the
same bad manifest for _different reasons_ have not agreed on anything useful, and the
`manifest.verify.*` vectors compare the reason:

1. structure and `manifestVersion`
2. signature envelope — algorithm, known key ID, well-formed signature
3. canonical serializability
4. Ed25519 signature
5. validity window
6. semantic content — networks, aliases

Nothing semantic is reported before the signature verifies. Describing the contents of a
document that failed authentication invites an attacker to use the error messages as an
oracle.

The algorithm is read from the document but only ever compared against the single value this
build accepts, so a manifest cannot downgrade its own verification.

### 4. Trust terminates in the package

Public keys are **compiled in** (`src/core/trusted-keys.ts`, `src/tx402/trusted_keys.py`). A
key shipped alongside a manifest authenticates nothing — an attacker who can replace the
manifest can replace an adjacent key file just as easily. There is no remote key fetch in
v0.1 and there will not be one without a new threat model: fetching a key at construction
would turn an offline integrity check into a network dependency on tx402 infrastructure,
which SPEC §13.1 rules out architecturally.

Rotation **adds** an entry rather than replacing one, so manifests signed by a previous key
keep verifying for their remaining lifetime. A key is removed only once every manifest it
signed has expired.

### 5. The manifest is embedded as generated source

`core-spec/manifests/bundled.manifest.json` is the signed source of truth. Neither SDK can
read it at runtime — it is not inside either published package, and reaching for the
filesystem would break the serverless and edge deployments ADR-007 explicitly protects. So
`node tools/manifest-signer/index.js embed` emits it as source into both packages, and
`embed` refuses to run on a manifest that does not verify.

A test in each language asserts the embedded copy still equals the JSON, so a hand edit to a
generated file is caught even if the tool is never re-run.

### 6. Python takes a `cryptography` dependency

CPython's standard library has no Ed25519. SPEC §5.4 requires offline signature verification
as a precondition of client construction, and SPEC §3.2 forbids implementing Ed25519 from
scratch. `cryptography>=42` therefore joins the Python core dependencies — not an extra,
because manifest verification is not optional.

TypeScript needs no equivalent: `node:crypto` provides synchronous Ed25519 verification, and
synchronous is required because SPEC §4.1 has `createTx402Client` validate all configuration
synchronously.

The runtime validator in both languages is hand-written rather than schema-driven. A JSON
Schema for the manifest exists in `core-spec/schemas/` and is the authority for the
conformance runners, the signing tool, and CI — but shipping a schema validator would add
roughly 30 KiB gzipped to the TypeScript core path, blowing the ADR-008 gate outright, and
would put a validation library in every Python user's install path. The narrower runtime
check and the schema are kept in agreement by the fixtures.

## Consequences

- No SPEC **MUST** is weakened. Every item concretizes something §5.4 left to the
  implementation.
- `tools/manifest-signer` carries a third copy of the canonicalizer. That duplication is safe
  because this copy produces the bytes that get _signed_ while the two SDK copies produce the
  bytes that get _verified_: a one-byte disagreement fails the `manifest.verify` vectors
  immediately. The signature is itself the cross-check, and a stronger one than a shared
  import would be.
- The canonical form is frozen. Changing any of the five rules invalidates every existing
  signature and requires a new ADR plus a `/v2` domain prefix.
- Manifest expiry bounds the blast radius of a compromised manifest even if the signing key
  is never rotated. The bundled manifest is valid until **2027-08-02** and must be re-issued
  before then; SPEC §15 makes that a patch release.
- The release signing key is generated locally and is gitignored
  (`core-spec/manifests/keys/*.private.*`). Before `0.1.0` it must be regenerated inside a
  secure environment and held in CI OIDC or a secret manager per SPEC §13. Tracked as open
  item **O12**.
