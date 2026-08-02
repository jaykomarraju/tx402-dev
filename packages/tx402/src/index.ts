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
 * Status: scaffold. The client itself lands in M1 (see PLAN.md §6, session S3).
 */

export {
  PACKAGE_NAME,
  X402_PROTOCOL_VERSION,
  PROJECT_URLS,
  PROTOCOL_HEADERS,
  RESERVED_REQUEST_HEADERS,
  REQUEST_ID_HEADER,
} from "./meta.js";
