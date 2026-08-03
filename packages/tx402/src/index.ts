/**
 * tx402 — resilient x402 buyer SDK.
 *
 * This is the **core import path**. It is size-gated per ADR-008 and must never pull in a
 * chain adapter, a signer implementation, or CLI code. Chain support lives behind the
 * `tx402/evm` and `tx402/solana` subpath exports; private-key convenience adapters live
 * behind `tx402/signers` and are kept isolated per SEC-001.
 *
 * @example
 * ```ts
 * import { createTx402Client } from "tx402";
 *
 * const client = createTx402Client({
 *   signers: { evm, solana },
 *   policy: {
 *     maxPerRequest: "0.50 USDC",
 *     maxPerHour: "10.00 USDC",
 *     allowedNetworks: ["eip155:8453", "solana:mainnet"],
 *   },
 * });
 *
 * const response = await client.fetch(url, init);
 * ```
 *
 * Status: the error taxonomy, release manifest, and canonical serialization landed at M0.
 * `createTx402Client` itself lands in M1 (see PLAN.md §6, session S3).
 */

export {
  PACKAGE_NAME,
  X402_PROTOCOL_VERSION,
  PROJECT_URLS,
  PROTOCOL_HEADERS,
  RESERVED_REQUEST_HEADERS,
  REQUEST_ID_HEADER,
} from "./meta.js";

/**
 * Error taxonomy (SPEC §8).
 *
 * Every failure the SDK raises is one of these fifteen classes, and every one carries the
 * same `code` string in TypeScript and in Python. Switch on `error.code` rather than on
 * class identity — the code is what survives a serialization boundary.
 */
export {
  TX402_ERROR_CODES,
  TX402_ERROR_TAXONOMY,
  TX402_ERROR_DESCRIPTORS,
  Tx402Error,
  isTx402Error,
  ConfigurationError,
  ReservedHeaderError,
  NonReplayableRequestError,
  UnsupportedProtocolError,
  UnsupportedSchemeError,
  InvalidPaymentRequiredError,
  BudgetExceededError,
  DomainNotAllowedError,
  InsufficientLiquidityError,
  SignerError,
  ClockSkewError,
  AmbiguousPaymentError,
  ResourceDeliveryError,
  PaidRedirectBlockedError,
  TransportError,
} from "./core/errors.js";

export type {
  Tx402ErrorCode,
  Tx402ErrorContext,
  Tx402ErrorDetails,
  Tx402ErrorDescriptor,
  Tx402ErrorOptions,
  Tx402Phase,
  Tx402Retryability,
} from "./core/errors.js";

/**
 * Release manifest (SPEC §5.4).
 *
 * `BUNDLED_MANIFEST` is the signed manifest shipped with this build. Callers may supply
 * their own through `manifest` in client config; it is verified on identical terms.
 */
export {
  verifyReleaseManifest,
  assertValidReleaseManifest,
  resolveNetwork,
  requireNetwork,
} from "./core/manifest.js";

export type {
  ReleaseManifest,
  ManifestNetwork,
  ManifestAsset,
  EvmManifestNetwork,
  SvmManifestNetwork,
  EvmManifestAsset,
  SvmManifestAsset,
  ManifestSignature,
  ManifestFailureReason,
  ManifestVerificationResult,
  NetworkEnvironment,
  NetworkResolution,
  VerifyManifestOptions,
} from "./core/manifest.js";

export { BUNDLED_MANIFEST } from "./core/bundled-manifest.js";
export { TRUSTED_MANIFEST_KEYS, MANIFEST_SIGNING_DOMAIN } from "./core/trusted-keys.js";
