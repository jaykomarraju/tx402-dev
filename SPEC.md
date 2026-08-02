**tx402**

**MVP v0.1 Engineering Specification**

*Resilient x402 Buyer SDK for TypeScript and Python*

| Document control | Value |
| :---- | :---- |
| Status | Approved implementation baseline |
| Version | 1.0 |
| Date | August 2, 2026 |
| Release scope | MVP v0.1 only |
| Owners | Product and Engineering |
| Primary packages | @tx402/sdk and tx402 |
| Supported production networks | Base Mainnet and Solana Mainnet |
| Supported test networks | Base Sepolia and Solana Devnet |

*Normative language: MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are binding as defined in RFC 2119 style usage.*

# **0\. How to Use This Specification**

This document is the sole implementation authority for tx402 MVP v0.1. The PRD explains product intent; this specification defines build behavior. When the PRD and this specification differ, this specification governs v0.1 implementation. Any behavior not explicitly permitted is out of scope.

* All production code, package APIs, schemas, tests, release gates, and operational defaults MUST conform to this document.  
* Changing a MUST or MUST NOT requires an Architecture Decision Record (ADR), review by both Product and Engineering owners, and a specification version increment.  
* Examples are normative where they define exported names, field names, defaults, or wire behavior.  
* External chain addresses, token addresses, facilitator URLs, and protocol package versions MUST be supplied through a signed release manifest rather than hardcoded into core logic.

| Priority | Meaning |
| :---- | :---- |
| P0 | Release-blocking correctness, security, or core user path |
| P1 | Required for v0.1 release but may be completed after P0 implementation |
| P2 | Permitted only if P0/P1 gates pass; must not expand public API incompatibly |

# **1\. Scope and Product Contract**

tx402 v0.1 is a local, non-custodial buyer-side SDK that wraps standard HTTP clients, interprets x402 PaymentRequired responses, selects a same-chain payment route, enforces local spend policy, creates a chain-specific payment authorization, retries the resource request, and exposes structured diagnostics. It does not run a hosted settlement service and does not bridge funds.

| In scope | Out of scope |
| :---- | :---- |
| TypeScript and Python buyer SDKs | Merchant/server middleware or reverse proxy |
| Base and Solana payment authorization | Wormhole, CCTP, DEX swaps, or cross-chain payment execution |
| Configurable multi-facilitator metadata and route health | Operating a tx402-hosted facilitator |
| Local policy engine and rolling spend ledger | Custody, wallet creation, key storage, or treasury rebalancing |
| Fetch/httpx-compatible request wrappers | Go, Rust, browser wallet UI, mobile SDKs |
| CLI endpoint diagnostics for TypeScript package | Hosted dashboard or remote telemetry ingestion |
| Protocol v2 headers and modular decoder boundary | Dynamic upto pricing or batch settlement |

## **1.1 Release success criteria**

* First successful paid testnet call in less than five minutes from package installation using documented examples.  
* No raw private key leaves the process. The core library accepts signer interfaces; convenience private-key adapters are isolated optional modules.  
* At least 99.95% successful payment handshakes in the defined fault-injection suite when at least one compatible route and facilitator remain healthy.  
* Less than 15 ms p95 SDK overhead on non-402 requests, excluding network time and signer latency.  
* Less than 150 ms p95 routing/failover decision overhead after a 402 is parsed, excluding merchant, chain, and facilitator network round-trip time.  
* No unhandled promise rejection, uncaught Python exception, duplicate body consumption, or silent policy bypass in the release test matrix.

# **2\. Architectural Decisions**

**ADR-001 \- Same-chain-only synchronous payment**

| Field | Specification |
| :---- | :---- |
| Decision | v0.1 MUST pay only on a network explicitly offered by the merchant and directly supported by a configured signer and sufficient native USDC balance. No bridge or swap may execute inside fetch(). |
| Rationale | x402 is designed around a short HTTP challenge-response loop. Cross-chain transfer introduces quoting, source-chain execution, finality, solver, relayer, and destination-chain dependencies that cannot provide deterministic sub-second completion. |
| Consequences | Base and Solana are production networks. Wormhole integration is deferred behind a ChainLiquidityProvider extension point and cannot be enabled in v0.1. |

**ADR-002 \- Facilitator model**

| Field | Specification |
| :---- | :---- |
| Decision | The client creates payment payloads but does not call /verify or /settle as part of the normal buyer flow. The merchant owns verification and settlement. Facilitator configuration in the buyer SDK is used only for compatibility discovery, health metadata, and diagnostics when the PaymentRequired object identifies or permits facilitator selection. |
| Rationale | The canonical x402 flow sends the signed payment payload back to the merchant; the merchant verifies and settles directly or through a facilitator. Buyer-side direct settlement would violate role boundaries and create duplicate-settlement races. |
| Consequences | The resource retry is authoritative. A successful HTTP response plus valid PAYMENT-RESPONSE is the payment outcome. Facilitator health cannot override merchant requirements. |

**ADR-003 \- Failover semantics**

| Field | Specification |
| :---- | :---- |
| Decision | Failover occurs across merchant-offered payment requirements and signer/RPC paths before signing, and across resource retries only when a fresh payment authorization can be safely created. The SDK MUST NOT submit one authorization concurrently to multiple merchants or directly race facilitator settle calls. |
| Rationale | A hedged direct-settlement race risks duplicate broadcasts and ambiguous resource fulfillment. Route selection can be fast without violating the protocol by scoring known health before signing. |
| Consequences | At most one PAYMENT-SIGNATURE is attached to one resource retry attempt. A new authorization requires a new nonce and idempotency safeguards. |

**ADR-004 \- Protocol version boundary**

| Field | Specification |
| :---- | :---- |
| Decision | v0.1 MUST implement x402 protocol v2 headers: PAYMENT-REQUIRED, PAYMENT-SIGNATURE, and PAYMENT-RESPONSE. Decoders and scheme handlers are plugins selected by version, scheme, and network. |
| Rationale | The protocol is evolving. Separating transport, envelope decoding, scheme signing, and routing prevents future v3 changes from rewriting the client. |
| Consequences | Unknown versions or schemes fail with typed UnsupportedProtocolError or UnsupportedSchemeError; they never fall back to heuristic parsing. |

**ADR-005 \- Shared behavioral specification**

| Field | Specification |
| :---- | :---- |
| Decision | TypeScript is the reference implementation for wire fixtures and protocol vectors. Python MUST pass the same language-neutral JSON conformance fixtures. Public behavior, error codes, route ordering, and policy arithmetic must match exactly. |
| Rationale | Independent implementations drift without shared vectors. |
| Consequences | A /conformance directory is versioned with fixtures consumed by both SDK test suites. |

**ADR-006 \- Money representation**

| Field | Specification |
| :---- | :---- |
| Decision | All token amounts and budget values MUST be represented internally as integer atomic units. Public string money inputs use decimal strings; JavaScript number and Python float inputs are rejected. |
| Rationale | Floating-point arithmetic can bypass caps or sign an incorrect value. |
| Consequences | USDC uses token metadata decimals from the release manifest, normally 6\. Comparisons are integer-only. |

**ADR-007 \- Local state**

| Field | Specification |
| :---- | :---- |
| Decision | The hourly budget ledger is process-local and persisted only when the application supplies a SpendStore. Default is an in-memory monotonic rolling-window store. |
| Rationale | The MVP is a library without hosted state. Implicit filesystem writes are unsafe in serverless and container environments. |
| Consequences | Multi-process deployments must provide a shared store adapter; otherwise limits apply per process. This behavior is explicit in diagnostics. |

# **3\. System Architecture**

Application / Agent  
        |  
        v  
Tx402Client.fetch / request  
        |  
        \+--\> Native HTTP Transport \------------------------------+  
        |                                                        |  
        |  non-402                                               | 402  
        |                                                        v  
        |                                             PaymentRequiredDecoder  
        |                                                        |  
        |                                             PolicyEngine (pre-sign)  
        |                                                        |  
        |                                             RoutePlanner / HealthIndex  
        |                                                        |  
        |                                      \+-----------------+----------------+  
        |                                      |                                  |  
        |                               EVM Scheme Handler                  SVM Scheme Handler  
        |                                      |                                  |  
        |                                 EvmSigner                         SolanaSigner  
        |                                      \+-----------------+----------------+  
        |                                                        |  
        |                                             PaymentSignatureEncoder  
        |                                                        |  
        \+\<-------------------------- Resource retry \-------------+  
                                                                 |  
                                                    PaymentResponseDecoder  
                                                                 |  
                                                          SpendLedger commit

| Component | Responsibility | Must not do |
| :---- | :---- | :---- |
| Transport | Issue requests, preserve request semantics, enforce timeouts, expose response | Parse chain payloads or access keys |
| Protocol decoder | Strict base64/JSON/schema validation and version dispatch | Guess malformed headers |
| Policy engine | Evaluate price, chain, domain, request count, rolling budget before signing | Perform network calls |
| Route planner | Filter and deterministically score compatible requirements | Bridge assets or mutate balances |
| Health index | Maintain bounded local EWMA/circuit state for RPC and facilitator metadata | Send telemetry remotely by default |
| Scheme handler | Build and serialize network-specific authorization | Own private keys |
| Signer adapter | Sign typed payload/transaction through caller-provided signer | Export key material |
| Spend ledger | Reserve, commit, release, and query spend atomically | Use floating point |
| Diagnostics | Emit structured events with redaction | Log signatures, secrets, full authorization payloads |

## **3.1 Repository layout**

/tx402  
  /packages  
    /sdk-ts                 \# @tx402/sdk  
    /cli                    \# bundled npx tx402  
    /sdk-python             \# PyPI tx402  
  /core-spec  
    /schemas                \# JSON Schema 2020-12  
    /conformance            \# language-neutral test vectors  
    /manifests              \# signed network/token release manifests  
  /examples  
    /typescript  
    /python  
  /tests  
    /integration  
    /fault-injection  
    /performance  
    /security  
  /docs  
    /api  
    /operations  
    /security  
  /adr

## **3.2 Dependency policy**

* TypeScript runtime target: Node.js 20 LTS or newer. Package output: ESM primary with documented CommonJS compatibility wrapper only if bundle target remains under size gate.  
* Python runtime target: CPython 3.10-3.13. HTTP transport integration targets httpx 0.27+ compatible interfaces.  
* Cryptographic signing MUST use audited upstream primitives. The SDK MUST NOT implement secp256k1, Ed25519, Keccak, SHA-256, or base58 primitives from scratch.  
* All dependencies MUST be pinned through lockfiles, scanned for licenses and known vulnerabilities, and reproducibly built in CI.  
* Network and token data MUST come from release manifests, not mutable third-party discovery at runtime.

# **4\. Public SDK API**

## **4.1 TypeScript**

import { createTx402Client } from "@tx402/sdk";

const client \= createTx402Client({  
  signers: { evm, solana },  
  policy: {  
    maxPerRequest: "0.50 USDC",  
    maxPerHour: "10.00 USDC",  
    allowedNetworks: \["eip155:8453", "solana:mainnet"\],  
  },  
});

const response \= await client.fetch(url, init);

| Export | Required signature/behavior |
| :---- | :---- |
| createTx402Client(config) | Returns immutable Tx402Client; validates all configuration synchronously. |
| client.fetch(input, init?) | WHATWG-fetch-compatible Promise\<Response\>. Handles at most configured payment attempts. |
| client.inspect(input, init?) | Performs request through first 402 and returns a PaymentInspection without signing or retrying. |
| client.getBudgetState() | Returns immutable local ledger snapshot. |
| client.resetHealth() | Clears in-memory health metrics; does not clear spend ledger. |
| isTx402Error(error) | Type guard for all SDK typed errors. |

## **4.2 Python**

from tx402 import Tx402Client, Policy

client \= Tx402Client(  
    evm\_signer=evm\_signer,  
    solana\_signer=solana\_signer,  
    policy=Policy(  
        max\_per\_request="0.50 USDC",  
        max\_per\_hour="10.00 USDC",  
        allowed\_networks=\["eip155:8453", "solana:mainnet"\],  
    ),  
)

response \= client.post(url, json={"prompt": "Hello"})

| Export | Required signature/behavior |
| :---- | :---- |
| Tx402Client | Synchronous client backed by httpx.Client-compatible transport. |
| AsyncTx402Client | Asynchronous client backed by httpx.AsyncClient-compatible transport. |
| client.request(method, url, \*\*kwargs) | HTTPX-compatible request path with payment handling. |
| client.inspect(method, url, \*\*kwargs) | Returns PaymentInspection without signing. |
| Policy | Frozen validated policy object. |
| Tx402Error | Base class with code, message, retryable, context, cause. |

## **4.3 Configuration schema**

| Field | Type | Default | Rules |
| :---- | :---- | :---- | :---- |
| signers.evm | EvmSigner | absent | absent | Required to select EVM routes. |
| signers.solana | SolanaSigner | absent | absent | Required to select Solana routes. |
| policy.maxPerRequest | Money string | "0.50 USDC" | Must be positive atomic-exact value. |
| policy.maxPerHour | Money string | "10.00 USDC" | Must be \>= maxPerRequest. |
| policy.allowedNetworks | CAIP-2\[\] | Base \+ Solana production | Empty list is invalid. |
| policy.allowedDomains | DomainPattern\[\] | \["\*"\] | Applied to normalized URL host before first request and retry. |
| policy.maxPaidAttempts | integer | 2 | Range 1-3; counts signed retries, not initial request. |
| timeouts.initialRequestMs | integer | caller transport default | SDK does not silently shorten caller timeout. |
| timeouts.paymentRetryMs | integer | 10,000 | Covers merchant retry; minimum 1,000. |
| routing.preferNetworks | CAIP-2\[\] | \[\] | Tie-break preference only. |
| routing.maxQuoteAgeMs | integer | 5,000 | Reject older PaymentRequired timestamps when present. |
| spendStore | SpendStore | MemorySpendStore | Must support atomic reserve/commit/release. |
| logger | Tx402Logger | NoopLogger | Receives redacted structured events. |
| clock | Clock | system \+ monotonic | Injectable only for test. |
| manifest | ReleaseManifest | bundled signed manifest | Signature and version verified at construction. |

# **5\. Protocol and Data Schemas**

The exact upstream x402 v2 envelope fields MUST be implemented from the pinned protocol dependency and conformance fixtures. tx402 MUST not invent incompatible wire fields. The following are tx402 internal normalized schemas used across languages.

## **5.1 NormalizedPaymentRequired**

{  
  "protocolVersion": 2,  
  "resource": { "url": "https://...", "method": "POST" },  
  "requirements": \[  
    {  
      "index": 0,  
      "scheme": "exact",  
      "network": "eip155:8453",  
      "asset": "0x...",  
      "amountAtomic": "50000",  
      "payTo": "0x...",  
      "maxTimeoutSeconds": 60,  
      "extra": {},  
      "rawHash": "sha256:..."  
    }  
  \],  
  "receivedAt": "2026-08-02T22:56:00.000Z",  
  "headerHash": "sha256:..."  
}

| Field | Validation |
| :---- | :---- |
| protocolVersion | Exactly integer 2\. |
| resource.url | Absolute HTTPS URL; normalized origin must match requested resource unless redirect policy explicitly permits. |
| resource.method | Uppercase HTTP method; must match original method. |
| requirements | 1-32 entries; stable input ordering preserved. |
| network | Strict CAIP-2 identifier and present in manifest. |
| amountAtomic | Unsigned base-10 integer string, \>0. |
| payTo | Validated by network handler. |
| rawHash/headerHash | SHA-256 used for diagnostics/idempotency, never authorization. |

## **5.2 RouteCandidate**

{  
  "requirementIndex": 0,  
  "network": "eip155:8453",  
  "scheme": "exact",  
  "assetId": "eip155:8453/erc20:0x...",  
  "amountAtomic": "50000",  
  "signerId": "evm:0xabc...",  
  "balanceAtomic": "12500000",  
  "estimatedFeeAtomic": "0",  
  "healthScore": 0.97,  
  "rank": 1,  
  "rejectionReasons": \[\]  
}

## **5.3 Spend ledger schemas**

SpendReservation {  
  reservationId: UUIDv7,  
  policyScope: string,  
  requestFingerprint: sha256,  
  assetId: CAIP19,  
  amountAtomic: uint-string,  
  createdAtEpochMs: int,  
  expiresAtEpochMs: int,  
  state: "reserved" | "committed" | "released" | "expired"  
}

SpendEntry {  
  settlementId?: string,  
  requestFingerprint: sha256,  
  assetId: CAIP19,  
  amountAtomic: uint-string,  
  committedAtEpochMs: int  
}

* Reservation TTL is 120 seconds. Expired reservations MUST not count toward the hourly budget.  
* Hourly budget is a rolling window over committed entries plus active reservations in \[now-3,600,000 ms, now\].  
* Reservation is created atomically before signing. It is committed only after a successful paid response. It is released on terminal failure.  
* If payment settlement is reported successful but resource response is unusable, the spend remains committed and the SDK raises ResourceDeliveryError with paid=true.

## **5.4 Release manifest**

{  
  "manifestVersion": 1,  
  "release": "0.1.0",  
  "issuedAt": "RFC3339",  
  "expiresAt": "RFC3339",  
  "networks": {  
    "eip155:8453": {  
      "environment": "production",  
      "rpcUrls": \["https://..."\],  
      "assets": \[{"symbol":"USDC","address":"0x...","decimals":6,"schemes":\["exact"\]}\]  
    },  
    "solana:mainnet": {  
      "environment": "production",  
      "rpcUrls": \["https://..."\],  
      "assets": \[{"symbol":"USDC","mint":"...","decimals":6,"schemes":\["exact"\]}\]  
    }  
  },  
  "signature": {"algorithm":"ed25519","keyId":"tx402-release-1","value":"base64"}  
}

* The bundled manifest MUST contain Base Mainnet, Base Sepolia, Solana Mainnet, and Solana Devnet.  
* Production and test networks cannot be mixed in one selected route. Test networks require explicit config opt-in.  
* Manifest signature failure, expiry, unknown key ID, duplicate network, or invalid token metadata prevents client construction.  
* Runtime remote manifest fetching is not included in v0.1.

# **6\. Request Execution State Machine**

IDLE \-\> INITIAL\_REQUEST  
INITIAL\_REQUEST \-\> COMPLETE\_UNPAID             (status \!= 402\)  
INITIAL\_REQUEST \-\> PARSE\_REQUIRED              (status \== 402\)  
PARSE\_REQUIRED \-\> POLICY\_PRECHECK  
POLICY\_PRECHECK \-\> PLAN\_ROUTES  
PLAN\_ROUTES \-\> RESERVE\_BUDGET  
RESERVE\_BUDGET \-\> SIGN  
SIGN \-\> RETRY\_RESOURCE  
RETRY\_RESOURCE \-\> COMPLETE\_PAID                (2xx \+ valid payment response)  
RETRY\_RESOURCE \-\> RECHALLENGED                 (402)  
RECHALLENGED \-\> PLAN\_ROUTES                    (fresh challenge, attempts remain)  
Any state \-\> FAILED                            (typed terminal error)

## **6.1 Initial request rules**

* The initial request MUST be byte-for-byte equivalent to the caller intent except for standard transport normalization.  
* The SDK MUST NOT attach payment headers preemptively in v0.1.  
* Caller-supplied PAYMENT-REQUIRED, PAYMENT-SIGNATURE, or PAYMENT-RESPONSE headers are rejected with ReservedHeaderError.  
* For requests with a body, the SDK MUST create a replayable body representation before sending. Streaming/non-replayable bodies fail before the initial request with NonReplayableRequestError unless the caller provides a bodyFactory callback.  
* Automatic redirect following is disabled for a paid retry unless redirect target has the same normalized origin. Cross-origin redirect raises PaidRedirectBlockedError.

## **6.2 Parsing and validation**

1. Read PAYMENT-REQUIRED header. If absent, optionally read the upstream-defined v2 body form only when the pinned protocol implementation declares it valid.  
2. Decode base64 using strict alphabet and padding rules; decoded size maximum 64 KiB.  
3. Parse JSON with duplicate-key rejection and maximum nesting depth 16\.  
4. Validate upstream schema and normalize. Maximum 32 requirements.  
5. Bind the challenge to the original URL and method. Reject mismatches.  
6. Compute diagnostic hashes; never log raw payment challenge by default.

## **6.3 Policy evaluation order**

7. Normalize and validate destination domain against allowedDomains.  
8. Reject unsupported or disallowed networks.  
9. Reject unsupported schemes/assets.  
10. Reject amount above maxPerRequest.  
11. Query rolling spend and reject if amount would exceed maxPerHour.  
12. Reject expired or unreasonably future-dated challenge metadata when defined by protocol.  
13. Only after all checks pass may route planning query balances or invoke a signer.

## **6.4 Route planning algorithm**

14. Create one candidate for each requirement with a matching enabled scheme handler and configured signer.  
15. Fetch balances concurrently per unique network/asset using configured RPC providers. Balance timeout: 600 ms per provider; maximum two providers per network.  
16. Candidate is viable when balanceAtomic \>= amountAtomic and signer can authorize the required asset/scheme.  
17. Compute healthScore from local EWMA success, latency, and circuit state. New endpoints start at 0.80.  
18. Order by: viable first; policy preference rank; lower expected buyer fee; higher healthScore; lower observed latency; original requirement index.  
19. Ordering MUST be deterministic for identical inputs and health state.  
20. If no viable candidate exists, raise InsufficientLiquidityError with redacted per-network deficits.

## **6.5 Circuit breaker and health index**

| Setting | Value |
| :---- | :---- |
| Latency EWMA alpha | 0.20 |
| Failure window | Last 20 observations |
| Open threshold | 5 consecutive failures OR \>=50% failures with \>=10 samples |
| Open duration | 30 seconds |
| Half-open probes | 1 |
| Success close threshold | 1 successful probe |
| Health retention | 30 minutes idle |
| Maximum indexed endpoints | 128 LRU |

Circuit state influences route order but cannot authorize a network or facilitator not offered by the merchant. An open endpoint may be used only when every compatible endpoint is open, and it is ranked last.

## **6.6 Signing rules**

* Budget reservation MUST exist before signer invocation.  
* Every authorization MUST use a cryptographically secure 32-byte nonce or the equivalent uniqueness primitive required by the upstream scheme.  
* Authorization lifetime default is min(60 seconds, merchant max timeout). It must never exceed the merchant bound.  
* The signer request presented to external signers MUST contain human-readable domain, asset, atomic amount, decimal amount, recipient, network, expiry, and request hash.  
* Signatures and complete signed transactions are Sensitive. They may exist in memory only as needed and MUST be redacted from exceptions and logs.  
* Clock skew greater than 15 seconds detected from merchant/facilitator metadata raises ClockSkewError; the SDK does not modify system time.

## **6.7 Paid retry and completion**

* The SDK clones the original request, adds exactly one PAYMENT-SIGNATURE header, and adds X-TX402-REQUEST-ID containing a UUIDv7 diagnostic ID. The latter is non-authoritative and may be omitted by strict integrations through config.  
* Idempotency-Key supplied by the caller is preserved. The SDK does not synthesize an application idempotency key because merchant semantics are unknown.  
* A 2xx response is considered paid-success only when any required upstream PAYMENT-RESPONSE parses successfully. Missing response metadata is accepted only if the upstream pinned protocol marks it optional; a diagnostic warning is emitted.  
* On a repeated 402, the new challenge must be parsed from scratch. The old signature is never reused. Maximum signed attempts defaults to 2\.  
* 5xx, timeout, or network failure after signature submission is ambiguous. The SDK releases an unconfirmed reservation only when no payment success evidence exists; it raises AmbiguousPaymentError with reservation retained until TTL. The caller must not blindly retry without an idempotency strategy.

# **7\. Chain Adapters**

## **7.1 EVM adapter \- Base**

* Production network: eip155:8453. Test network: Base Sepolia from the signed manifest.  
* v0.1 supports the exact payment scheme for native USDC through the upstream x402 EVM implementation and its supported authorization primitive. No generic ERC-20 support is exposed.  
* EvmSigner interface MUST support address discovery and EIP-712 typed-data signing. A privateKeyToAccount convenience adapter may be provided in an optional package entry point.  
* RPC calls are limited to chain identity, token balance, and required nonce/domain metadata. The buyer SDK does not broadcast settlement transactions.  
* Before signing, chain ID returned by RPC MUST equal the candidate CAIP-2 chain ID. Mismatch opens the endpoint circuit and tries the next RPC.

interface EvmSigner {  
  readonly kind: "evm";  
  getAddress(): Promise\<\`0x${string}\`\>;  
  signTypedData(request: EvmTypedDataRequest): Promise\<\`0x${string}\`\>;  
}

## **7.2 SVM adapter \- Solana**

* Production network identifier is the exact upstream CAIP-2 identifier pinned in the manifest and normalized internally to solana:mainnet alias only for display. Test network is Solana Devnet.  
* v0.1 supports native USDC SPL token payment requirements accepted by the pinned x402 SVM scheme. Token-2022 is excluded unless the pinned conformance suite explicitly requires it for USDC on a supported network.  
* SolanaSigner MUST expose public key and sign the upstream-defined transaction/message bytes without exporting secret material.  
* RPC calls are limited to genesis/cluster validation, token account discovery, balance, blockhash or transaction metadata required by the upstream payment scheme. The buyer does not submit settlement.  
* All serialized transaction size and account constraints are validated before signer invocation.

interface SolanaSigner {  
  readonly kind: "solana";  
  getPublicKey(): Promise\<string\>;  
  signTransaction(request: SolanaSignRequest): Promise\<Uint8Array\>;  
}

## **7.3 Future cross-chain extension boundary**

The following interface is reserved but not exported as stable API in v0.1. It exists to prevent architecture coupling. No implementation ships.

interface ChainLiquidityProvider {  
  quote(sourceAssets, destinationRequirement, deadline): Promise\<LiquidityQuote\[\]\>;  
  execute(quote, signerSet): Promise\<LiquidityReceipt\>;  
}

* The synchronous Tx402Client MUST never call this interface in v0.1.  
* A future Wormhole Settlement adapter may implement it as an explicit pre-funding or treasury-rebalancing operation, not an invisible fetch side effect.  
* Adding cross-chain pay-in requires a new threat model, slippage policy, solver trust policy, destination finality policy, and separate release specification.

# **8\. Error Model**

| Code / class | Retryable | Meaning / required context |
| :---- | :---- | :---- |
| TX402\_CONFIG\_INVALID / ConfigurationError | No | Invalid config path and reason. |
| TX402\_RESERVED\_HEADER / ReservedHeaderError | No | Caller supplied protocol-owned header. |
| TX402\_NON\_REPLAYABLE / NonReplayableRequestError | No | Request body cannot be retried safely. |
| TX402\_PROTOCOL\_UNSUPPORTED / UnsupportedProtocolError | No | Observed protocol version. |
| TX402\_SCHEME\_UNSUPPORTED / UnsupportedSchemeError | No | Schemes/networks offered. |
| TX402\_PAYMENT\_REQUIRED\_INVALID / InvalidPaymentRequiredError | No | Schema path, size, or binding error. |
| TX402\_POLICY\_BUDGET / BudgetExceededError | No | Requested, cap, rolling committed/reserved. |
| TX402\_POLICY\_DOMAIN / DomainNotAllowedError | No | Normalized host only. |
| TX402\_LIQUIDITY / InsufficientLiquidityError | Conditional | Per-network available and required atomic amounts. |
| TX402\_SIGNER / SignerError | Conditional | Signer kind and safe cause category. |
| TX402\_CLOCK\_SKEW / ClockSkewError | Yes after correction | Observed skew and permitted threshold. |
| TX402\_PAYMENT\_AMBIGUOUS / AmbiguousPaymentError | No automatic retry | Request ID, reservation ID, paid unknown. |
| TX402\_RESOURCE\_DELIVERY / ResourceDeliveryError | App-dependent | paid=true when settlement evidence exists. |
| TX402\_REDIRECT\_BLOCKED / PaidRedirectBlockedError | No | Source and destination origins. |
| TX402\_TRANSPORT / TransportError | Yes by caller policy | Phase and safe network error category. |

interface Tx402ErrorContext {  
  requestId: string;  
  phase: "initial" | "parse" | "policy" | "route" | "sign" | "retry" | "complete";  
  network?: string;  
  scheme?: string;  
  amountAtomic?: string;  
  assetId?: string;  
  paid?: boolean | "unknown";  
  reservationId?: string;  
}

# **9\. Security Requirements**

**SEC-001** Core APIs MUST accept signer abstractions, not raw private key strings.

**Acceptance:** Static API review confirms no raw key parameter in primary client config.

**SEC-002** All policy evaluation and spend reservation MUST occur before signing.

**Acceptance:** Fault tests assert signer invocation count is zero for every rejected policy case.

**SEC-003** Logs and errors MUST redact authorization payloads, signatures, secret keys, bearer tokens, cookies, and request bodies by default.

**Acceptance:** Snapshot tests cover every event/error type with seeded secrets.

**SEC-004** Only HTTPS resource URLs are allowed by default. HTTP is permitted solely for localhost test mode through explicit allowInsecureLocalhost=true.

**Acceptance:** Integration tests reject public HTTP URLs.

**SEC-005** Redirects on paid retries MUST remain same-origin.

**Acceptance:** Cross-origin 301/302/307/308 tests fail before transmitting PAYMENT-SIGNATURE.

**SEC-006** PaymentRequired parsing MUST enforce byte, depth, array, integer, and string length limits.

**Acceptance:** Fuzz suite runs malformed and oversized corpus without crash or excessive allocation.

**SEC-007** Manifest and conformance artifacts MUST be integrity checked in release builds.

**Acceptance:** CI verifies signed manifest and hashes before publishing.

**SEC-008** Dependency provenance MUST include lockfile, SBOM, license report, and vulnerability scan.

**Acceptance:** Release pipeline blocks on critical/high exploitable findings unless documented exception is approved.

**SEC-009** Request fingerprinting MUST exclude secrets while binding method, normalized URL, body digest, and challenge hash.

**Acceptance:** Golden vectors match in TS and Python.

**SEC-010** No remote telemetry is enabled by default.

**Acceptance:** Network-deny test confirms SDK makes only merchant and configured RPC calls.

## **9.1 Threat model**

| Threat | Mitigation |
| :---- | :---- |
| Malicious merchant price spike | Atomic policy checks before signer invocation. |
| Replay of captured signature | Upstream nonce/expiry primitives; HTTPS; one authorization per attempt. |
| RPC chain spoofing | Verify chain/genesis identity before trusting balance or metadata. |
| Prompt injection extracts wallet key | Signer abstraction and no key logging; external wallet/KMS recommended. |
| Cross-origin redirect leaks signature | Block paid cross-origin redirects. |
| Duplicate settlement after timeout | Do not direct-settle from buyer; classify ambiguous outcomes and retain reservation. |
| Budget race across concurrent requests | Atomic SpendStore reserve operation. |
| Malformed 402 resource exhaustion | Strict parser limits and fuzzing. |
| Compromised manifest | Offline signature verification and expiry. |

# **10\. Observability and Diagnostics**

| Event | Minimum fields |
| :---- | :---- |
| request.started | requestId, method, normalizedHost |
| payment.required | requestId, requirementCount, headerHash |
| policy.checked | requestId, outcome, policyCode |
| route.planned | requestId, candidateCount, selectedNetwork, selectedScheme |
| budget.reserved | requestId, reservationId, assetId, amountAtomic |
| sign.started / completed | requestId, signerKind, durationMs; never signature |
| request.retried | requestId, attempt, selectedNetwork |
| payment.completed | requestId, paid, settlementIdHash, totalSdkOverheadMs |
| request.failed | requestId, errorCode, phase, paid |

* Logger interface methods: debug, info, warn, error accepting a structured object.  
* No console output from library code. CLI may render human-readable output from the structured event stream.  
* Durations use a monotonic clock. Timestamps use UTC RFC3339.  
* OpenTelemetry hooks MAY be exposed as experimental callbacks but no OTel runtime dependency ships in the core bundle.

# **11\. CLI Specification**

npx tx402 call \<URL\> \[--method GET\] \[--body @file.json\]  
  \--max-spend "0.10 USDC"  
  \--network eip155:8453|solana:mainnet  
  \--dry-run  
  \--json  
  \--timeout 10000

* \--dry-run performs the initial request, parses the challenge, evaluates policy, plans routes, and prints what would be signed; it MUST NOT invoke a signer.  
* Private keys are not accepted as command-line flags. Development keys may be read from documented environment variables only after an explicit warning; hardware/external signer adapters are preferred.  
* \--json outputs one JSON object with schema version, inspection, route, timings, and error. Human output writes diagnostics to stderr and response body to stdout.  
* CLI exit codes: 0 success; 2 usage/config; 3 policy; 4 liquidity; 5 protocol; 6 signer; 7 transport; 8 ambiguous payment; 9 resource failure.

# **12\. Testing Strategy and Release Gates**

## **12.1 Test layers**

| Layer | Required coverage |
| :---- | :---- |
| Unit | Parsers, money, policy, ordering, circuits, stores, redaction, error mapping. \>=90% line and branch in core modules. |
| Conformance | Every fixture passes identically in TS and Python; includes valid and invalid upstream v2 vectors. |
| Contract | Signer, transport, SpendStore, clock, logger, and manifest adapter contract suites. |
| Integration | Mock merchant \+ mock facilitator \+ local chain simulators; all state transitions. |
| Public testnet | Base Sepolia and Solana Devnet paid-call smoke suites. |
| Fault injection | Latency, packet loss, malformed headers, RPC mismatch, duplicate challenge, timeout after signature. |
| Fuzz/property | Base64/JSON/payment decoder; money strings; URL/domain policy; route determinism. |
| Performance | Non-402 overhead, 402 planning overhead, memory, package size, concurrency. |
| Security | Secret redaction, redirect leak, SSRF boundaries, dependency/SBOM, static analysis. |
| Compatibility | Node 20/22; Python 3.10-3.13; Linux/macOS/Windows CI where supported. |

## **12.2 Normative test scenarios**

| ID | Scenario | Expected result |
| :---- | :---- | :---- |
| T-001 | 200 response without 402 | Returned unchanged; no signer, balance, or ledger call. |
| T-002 | Valid Base requirement and sufficient balance | One reservation, one EIP signing call, one paid retry. |
| T-003 | Valid Solana requirement and sufficient balance | One reservation, one SVM signing call, one paid retry. |
| T-004 | Base \+ Solana offered; preference Base | Base selected when both viable. |
| T-005 | Preferred Base insufficient, Solana sufficient | Solana selected automatically. |
| T-006 | Price above per-request cap | BudgetExceededError in \<2 ms local evaluation; signer count 0\. |
| T-007 | Concurrent requests exceed hourly cap | Exactly allowed reservations succeed; remainder atomically rejected. |
| T-008 | Primary RPC timeout, secondary healthy | Secondary used; route planning overhead \<150 ms p95 in controlled network. |
| T-009 | Malformed PAYMENT-REQUIRED | Typed invalid error; no signing. |
| T-010 | Repeated 402 with fresh challenge | Old reservation released/retained per outcome; new nonce; max attempts enforced. |
| T-011 | Network timeout after signature | AmbiguousPaymentError; reservation retained until TTL. |
| T-012 | Cross-origin redirect on paid retry | Blocked before signature transmission. |
| T-013 | Non-replayable streaming body | Rejected before initial request unless bodyFactory provided. |
| T-014 | Manifest signature invalid | Client construction fails. |
| T-015 | Logger receives seeded secrets | No secret appears in snapshots. |
| T-016 | TS/Python same fixture | Same selected route, error code, normalized output. |
| T-017 | Primary merchant path unavailable | TransportError; SDK does not fabricate alternate merchant/facilitator endpoint. |
| T-018 | Unknown scheme/network | Unsupported typed error with offered values. |
| T-019 | 50 Base Sepolia \+ 50 Solana Devnet calls | Zero SDK-caused signature failures or unhandled exceptions. |
| T-020 | 100% primary RPC packet loss | All requests use configured backup RPC when available. |

## **12.3 Performance methodology**

* Non-402 overhead benchmark uses an in-process HTTP server and compares native transport median/p95 against tx402 wrapper across 10,000 warmed requests. Gate: added p95 \<15 ms.  
* 402 decision overhead starts after complete challenge bytes are received and ends before signer invocation. It includes parse, policy, balance queries in mocked controlled latency, route sort, and reservation. Gate: p95 \<150 ms.  
* Budget rejection benchmark excludes client construction. Gate: p95 \<2 ms for in-memory store.  
* TypeScript published core import path gzipped size gate: \<25 KiB excluding optional chain adapters. The complete EVM+SVM install size is reported but not used as the core gate.  
* Memory leak test performs 100,000 mixed requests and requires stable retained heap after health LRU and ledger expiry.

## **12.4 Release blocking gates**

* All P0/P1 tests green on protected main branch.  
* No critical or high-severity unresolved security issue in reachable production code.  
* Conformance fixture parity between TypeScript and Python is 100%.  
* Package signatures/provenance, SBOMs, license checks, and reproducible build verification complete.  
* Public testnet smoke suite passes twice from clean environments.  
* API documentation, migration notes, examples, and error reference published.  
* Independent security review completed for parser, policy ordering, signer isolation, and replay/ambiguity behavior.

# **13\. Engineering Resources and Environments**

| Resource | Required implementation |
| :---- | :---- |
| Monorepo | pnpm workspace \+ Python project tooling; one protected main branch. |
| CI | Linux mandatory; Node/Python matrix; lint, typecheck, test, conformance, package, SBOM. |
| Test merchant | Deterministic local server that emits configurable 402 challenges and validates retries. |
| Mock facilitator | Implements pinned /verify and /settle behavior for server-side integration tests; not shipped as product. |
| Chain simulation | EVM local simulator and Solana local validator or faithful transaction fixture harness. |
| Fault proxy | Toxiproxy-compatible network fault injection for latency, resets, and packet loss. |
| Testnet wallets | Dedicated low-balance wallets funded only for automated Base Sepolia and Solana Devnet tests. |
| Secrets | CI OIDC or secret manager; never repository variables in plaintext. |
| Artifact registry | npm and PyPI trusted publishing with provenance. |
| Docs | Versioned API reference generated from source plus hand-written security and operations guides. |

## **13.1 No production backend**

MVP v0.1 requires no tx402-operated production API, database, queue, cache, dashboard, relayer, bridge, or facilitator. The only tx402-operated release resources are package registries, documentation hosting, source repository, CI, and optional static signed manifest distribution for future versions. This constraint is architectural, not merely a launch shortcut.

# **14\. Implementation Plan**

| Milestone | Deliverables | Exit criteria |
| :---- | :---- | :---- |
| M0 \- Spec fixtures | Schemas, manifest format, errors, conformance vectors, test merchant | Reviewed and frozen public names. |
| M1 \- Transport \+ protocol core | Initial request, strict v2 decode, replayable body, typed errors | T-001, T-009, T-013, T-018 pass in both languages. |
| M2 \- Policy \+ ledger | Money parser, domain/network rules, atomic store | T-006, T-007 pass; property tests green. |
| M3 \- Base adapter | EVM signer, balance, exact scheme payload | Base local \+ Sepolia tests pass. |
| M4 \- Solana adapter | SVM signer, token balance, exact payload | Solana local \+ Devnet tests pass. |
| M5 \- Routing \+ health | Deterministic planner, RPC fallback, circuits | T-004, T-005, T-008, T-020 pass. |
| M6 \- Completion semantics | Retry, settlement response, ambiguity handling | T-010 through T-012 pass. |
| M7 \- CLI \+ docs | call/dry-run/json, examples, error reference | Fresh-user TTV test \<5 minutes. |
| M8 \- Hardening/release | Fuzz, perf, security review, provenance, publish | All release gates pass. |

# **15\. Operational and Compatibility Policies**

* Semantic versioning applies. Any exported type removal, error code change, default policy relaxation, or wire behavior change requires a major version after 1.0; during 0.x, release notes must explicitly identify breaks.  
* Protocol dependency upgrades require replaying all conformance fixtures and adding fixtures for every new accepted envelope/scheme.  
* Network/token manifest updates are patch releases when they do not change API behavior. New production networks are minor releases and require a chain adapter security review.  
* Deprecations remain for at least one minor release and emit no console warnings from library code; they are surfaced through type/docs metadata.  
* No silent fallback from production to testnet, from USDC to another asset, or from a configured external signer to an environment key.

# **16\. Definition of Done**

* Published @tx402/sdk and tx402 packages install from clean environments and match documented checksums/provenance.  
* Base Mainnet and Solana Mainnet are enabled in the signed production manifest; Base Sepolia and Solana Devnet are enabled only with explicit test mode.  
* All exported APIs, defaults, schemas, errors, state transitions, and tests in this specification are implemented.  
* The SDK never bridges, swaps, broadcasts buyer settlement transactions, stores private keys, or contacts a tx402 backend.  
* All release gates in Section 12.4 pass and the security review has no unresolved release-blocking finding.  
* The engineer onboarding example achieves a successful paid testnet response in under five minutes without reading source code.

# **Appendix A. Normative External References**

| Reference | Use in this specification |
| :---- | :---- |
| x402 Foundation repository and v2 specification | Canonical payment flow, versioned envelopes, headers, schemes, and conformance behavior. |
| x402 facilitator documentation | Buyer/server/facilitator role separation and verify/settle flow. |
| CAIP-2 / CAIP-19 specifications | Network and asset identifiers. |
| Upstream EVM and SVM x402 packages pinned by release lockfile | Authorization creation and serialization. |
| Wormhole Settlement and finality documentation | Basis for excluding cross-chain settlement from synchronous v0.1 while preserving an extension boundary. |
| Circle CCTP documentation | Future treasury/pre-funding option; not a v0.1 payment path. |

# **Appendix B. Explicitly Rejected Alternatives**

| Alternative | Reason rejected for v0.1 |
| :---- | :---- |
| Wormhole inside client.fetch() | Cross-chain auction/finality dependencies violate deterministic sub-second objective and expand trust/security scope. |
| CCTP Fast Transfer inside client.fetch() | Still requires source-chain burn, attestation, and destination mint; unsuitable as invisible HTTP retry. |
| Buyer directly races facilitator /settle calls | Breaks canonical role separation and creates ambiguous duplicate settlement/resource fulfillment. |
| Floating-point dollar policy fields | Unsafe precision and cross-language inconsistency. |
| Automatic environment-key discovery in primary API | Surprising secret access and weak key isolation. Convenience adapters are explicit. |
| Implicit filesystem budget database | Fails in serverless/read-only/multi-process deployments. |
| Remote analytics by default | Violates privacy and zero-backend MVP architecture. |
| Supporting every Wormhole chain through generic adapters | Network support is not only transport; each chain requires signer, asset, scheme, RPC, security, and conformance work. |

# **Appendix C. PRD Traceability**

| PRD requirement | Engineering implementation |
| :---- | :---- |
| F1 facilitator health/failover | HealthIndex and deterministic requirement/RPC route fallback; no unsafe direct settle races. |
| F2 CAIP-2 auto-selector | Strict manifest-backed route planner with signer, balance, policy, fee, and health filters. |
| F3 budget guardrails | Integer atomic-unit PolicyEngine \+ atomic rolling-window SpendStore. |
| F4 EVM/SVM signing | Separate scheme handlers and signer interfaces for Base and Solana. |
| Native fetch/httpx wrapper | Tx402Client.fetch, Tx402Client, AsyncTx402Client. |
| \<15 ms non-402 overhead | Benchmark gate in Section 12.3. |
| \<150 ms failover overhead | Decision-overhead metric, not chain/facilitator round-trip guarantee. |
| No private-key transmission | Signer abstraction, redaction, no backend. |
| Wormhole future proofing | Non-exported ChainLiquidityProvider extension boundary; no v0.1 execution. |
