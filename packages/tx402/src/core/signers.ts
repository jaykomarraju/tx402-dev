/**
 * Signer contracts (SPEC §7.1, SEC-001).
 *
 * These live on the core path because `Tx402ClientConfig.signers` has to name them, but they
 * are **declarations only** — nothing here reaches a chain library, and the runtime guards
 * below are structural checks over plain objects. The implementations, and every dependency
 * they need, live behind the `tx402/evm` and `tx402/solana` subpath exports.
 *
 * SEC-001 is the reason this file describes an interface rather than a key format: the core
 * client accepts something that *can sign*, never something that *is a key*. A caller who
 * wants the convenience of a raw private key opts into it explicitly through `tx402/signers`.
 */

/** EIP-712 domain separator fields. */
export interface EvmTypedDataDomain {
  readonly name?: string;
  readonly version?: string;
  readonly chainId?: number;
  readonly verifyingContract?: string;
  readonly salt?: string;
}

/** One EIP-712 struct member. */
export interface EvmTypedDataField {
  readonly name: string;
  readonly type: string;
}

/**
 * The human-readable summary that must accompany every signing request (SPEC §6.6).
 *
 * EIP-712 typed data is precise and unreadable. SPEC §6.6 requires the request presented to
 * an external signer to also carry the domain, asset, atomic amount, decimal amount,
 * recipient, network, expiry, and request hash in a form a person can check on a hardware
 * wallet screen before approving. Every field here is derived from data tx402 has already
 * validated against the signed manifest and the local policy, and every field is
 * redaction-safe — no signature, no key, no request body.
 */
export interface EvmSignerPresentation {
  /** Canonical CAIP-2 network identifier the authorization is bound to. */
  readonly network: string;
  /** CAIP-19 asset identifier. */
  readonly assetId: string;
  /** Token symbol from the signed release manifest, for example `USDC`. */
  readonly assetSymbol: string;
  /** Amount in integer atomic units, exactly as it will be signed. */
  readonly amountAtomic: string;
  /** The same amount as a decimal string, using manifest decimals. */
  readonly amountDecimal: string;
  /** Merchant payout address. */
  readonly recipient: string;
  /** Normalized host of the resource being paid for. */
  readonly resourceHost: string;
  /** EIP-712 domain name of the token contract, for example `USD Coin`. */
  readonly domainName: string;
  /** Authorization expiry as an RFC 3339 UTC timestamp. */
  readonly expiresAt: string;
  /** SEC-009 request fingerprint. Diagnostic and idempotency use only. */
  readonly requestHash: string;
}

/** What an {@link EvmSigner} is asked to sign. */
export interface EvmTypedDataRequest {
  readonly domain: EvmTypedDataDomain;
  readonly types: Readonly<Record<string, readonly EvmTypedDataField[]>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
  /** SPEC §6.6's human-readable summary of the same authorization. */
  readonly presentation: EvmSignerPresentation;
}

/**
 * The EVM signer contract (SPEC §7.1).
 *
 * Address discovery is asynchronous because the realistic implementations — a KMS, a
 * hardware wallet, a remote signing service — cannot answer synchronously. tx402 resolves it
 * once per signer and caches it (ADR-010 decision 5, as amended at S5).
 */
export interface EvmSigner {
  readonly kind: "evm";
  getAddress(): Promise<`0x${string}`>;
  signTypedData(request: EvmTypedDataRequest): Promise<`0x${string}`>;
}

/** The Solana signer contract (SPEC §7.2). Implemented at M4. */
export interface SolanaSigner {
  readonly kind: "solana";
  getPublicKey(): Promise<string>;
  signTransaction(request: Readonly<Record<string, unknown>>): Promise<Uint8Array>;
}

/** Signers a client may be configured with (SPEC §4.1). */
export interface Tx402Signers {
  readonly evm?: EvmSigner;
  readonly solana?: SolanaSigner;
}

/**
 * Structural check, not `instanceof`.
 *
 * Callers routinely pass an object literal, a viem account wrapped by `tx402/signers`, or a
 * proxy around a remote signer. None of those share a prototype with anything tx402 owns.
 */
export function isEvmSigner(candidate: unknown): candidate is EvmSigner {
  if (typeof candidate !== "object" || candidate === null) return false;
  const signer = candidate as Partial<EvmSigner>;
  return (
    signer.kind === "evm" &&
    typeof signer.getAddress === "function" &&
    typeof signer.signTypedData === "function"
  );
}

/** Structural check for the Solana contract. Its adapter lands at M4. */
export function isSolanaSigner(candidate: unknown): candidate is SolanaSigner {
  if (typeof candidate !== "object" || candidate === null) return false;
  const signer = candidate as Partial<SolanaSigner>;
  return (
    signer.kind === "solana" &&
    typeof signer.getPublicKey === "function" &&
    typeof signer.signTransaction === "function"
  );
}
