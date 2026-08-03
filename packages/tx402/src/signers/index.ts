/**
 * Optional private-key convenience signer adapters.
 *
 * Deliberately isolated behind the `tx402/signers` subpath export. Per SEC-001 the primary
 * client configuration accepts **signer abstractions only** and never a raw private key
 * string, so nothing in the core API can reach this module: a caller has to import it by
 * name, which is what makes the choice explicit and auditable in a diff.
 *
 * **Use an external signer if you can.** SPEC §9.1 lists prompt injection extracting a wallet
 * key as a live threat for exactly the autonomous agents this SDK targets, and a key held in
 * process memory is a key an in-process compromise can read. A KMS, a hardware wallet, or a
 * remote signing service implements the same {@link EvmSigner} interface and keeps the key
 * outside the blast radius. This adapter exists for development and for small, dedicated,
 * low-balance wallets.
 *
 * The key is captured in a closure and is never stored on the returned object, never
 * serialized, and never logged. `toJSON` and Node's inspection hook are both overridden so
 * that a signer accidentally passed to a logger renders as a redacted placeholder rather
 * than as an object graph containing the account.
 *
 * @example
 * ```ts
 * import { privateKeyToEvmSigner } from "tx402/signers";
 *
 * const evm = privateKeyToEvmSigner(process.env.TX402_DEV_PRIVATE_KEY as `0x${string}`);
 * ```
 */

import { privateKeyToAccount } from "viem/accounts";

import type { EvmSigner, EvmTypedDataRequest } from "../core/signers.js";

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/u;

/** A signer with the key material redacted from every serialization path. */
export interface RedactedSigner {
  toJSON(): { readonly kind: string; readonly address: string };
}

/**
 * Wraps a raw secp256k1 private key as an {@link EvmSigner}.
 *
 * @param privateKey 32-byte hex, `0x`-prefixed. Never logged, and rejected before viem sees
 *                   it if it is malformed — a validation error from a chain library tends to
 *                   quote its input.
 */
export function privateKeyToEvmSigner(
  privateKey: `0x${string}`,
): EvmSigner & RedactedSigner {
  if (typeof privateKey !== "string" || !PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new TypeError(
      "privateKeyToEvmSigner expects a 0x-prefixed 32-byte hex private key",
    );
  }

  const account = privateKeyToAccount(privateKey);
  const address = account.address;

  const signer: EvmSigner & RedactedSigner = {
    kind: "evm",
    getAddress: () => Promise.resolve(address),
    signTypedData: (request: EvmTypedDataRequest) =>
      // `presentation` is tx402's human-readable summary (SPEC §6.6). viem signs the EIP-712
      // structure only, so it is deliberately not forwarded.
      account.signTypedData({
        domain: request.domain,
        types: request.types,
        primaryType: request.primaryType,
        message: request.message,
      } as Parameters<typeof account.signTypedData>[0]),
    toJSON: () => ({ kind: "evm", address }),
  };

  Object.defineProperty(signer, "address", { value: address, enumerable: true });
  Object.defineProperty(signer, Symbol.for("nodejs.util.inspect.custom"), {
    value: () => `EvmSigner(evm:${address})`,
    enumerable: false,
  });

  return Object.freeze(signer);
}
