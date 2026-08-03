/**
 * Stage B handlers — the TypeScript SDK executed against the shared vectors.
 *
 * One handler per vector `kind`. Registering a handler is what claims the kind; the runner
 * fails if a vector at or below {@link IMPLEMENTED_THROUGH} has none, so this file and
 * `IMPLEMENTED_THROUGH` move together.
 *
 * Handlers throw on mismatch rather than returning false, because the diff is the only
 * genuinely useful part of a conformance failure.
 */

import { expect } from "vitest";

import { BUNDLED_MANIFEST } from "../../src/core/bundled-manifest.js";
import { canonicalizeJson, CanonicalJsonError } from "../../src/core/canonical-json.js";
import { TX402_ERROR_TAXONOMY } from "../../src/core/errors.js";
import { isTx402Error } from "../../src/core/errors.js";
import {
  digestRequestBody,
  fingerprintRequest,
  normalizeFingerprintUrl,
} from "../../src/core/fingerprint.js";
import { MemorySpendStore } from "../../src/core/ledger.js";
import {
  resolveNetwork,
  verifyReleaseManifest,
  type EvmManifestNetwork,
  type ReleaseManifest,
} from "../../src/core/manifest.js";
import { decodePaymentRequired } from "../../src/core/protocol.js";
import {
  planExactEvmAuthorization,
  type ExactEvmRequirementInput,
} from "../../src/evm/plan.js";
import { registerHandler, type ConformanceVector } from "./runner.js";

/** Manifest failures all surface to callers as ConfigurationError (SPEC §5.4). */
const MANIFEST_ERROR_CODE = "TX402_CONFIG_INVALID";

registerHandler("errors.taxonomy", (vector: ConformanceVector) => {
  const expected = vector.expected as {
    entries: {
      code: string;
      className: string;
      retryability: string;
      retryable: boolean;
      requiredDetails: string[];
    }[];
  };

  // Compared as whole arrays, in order: the taxonomy's ordering is part of what is frozen,
  // and an entry-by-entry loop would let a reordering pass.
  const actual = TX402_ERROR_TAXONOMY.map((entry) => ({
    code: entry.code,
    className: entry.className,
    retryability: entry.retryability,
    retryable: entry.retryable,
    requiredDetails: [...entry.requiredDetails],
  }));

  expect(actual).toEqual(expected.entries);
});

registerHandler("canonical-json", (vector: ConformanceVector) => {
  const { document } = vector.input as { document: unknown };
  const expected = vector.expected as
    { canonical: string; sha256: string } | { error: string };

  if ("error" in expected) {
    try {
      canonicalizeJson(document);
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalJsonError);
      expect((error as CanonicalJsonError).reason).toBe(expected.error);
      return;
    }
    throw new Error(
      `Expected canonicalization to fail with ${expected.error}, but it succeeded`,
    );
  }

  expect(canonicalizeJson(document)).toBe(expected.canonical);
});

registerHandler("manifest.verify", (vector: ConformanceVector) => {
  const input = vector.input as {
    manifest: unknown;
    nowEpochMs: number;
    trustedKeys?: Record<string, string>;
  };
  const expected = vector.expected as
    { outcome: "valid" } | { outcome: "invalid"; errorCode: string; reason: string };

  const result = verifyReleaseManifest(input.manifest, {
    nowEpochMs: input.nowEpochMs,
    ...(input.trustedKeys ? { trustedKeys: input.trustedKeys } : {}),
  });

  if (expected.outcome === "valid") {
    if (!result.valid) {
      throw new Error(
        `Expected the manifest to verify, but it failed: ${result.reason} — ${result.message}`,
      );
    }
    return;
  }

  if (result.valid) {
    throw new Error(
      `Expected the manifest to be rejected with ${expected.reason}, but it verified`,
    );
  }

  expect(result.reason).toBe(expected.reason);
  expect(MANIFEST_ERROR_CODE).toBe(expected.errorCode);
});

registerHandler("manifest.network-resolution", (vector: ConformanceVector) => {
  const input = vector.input as { manifest: ReleaseManifest; query: string };
  const expected = vector.expected as
    { resolved: string; wasAlias: boolean } | { errorCode: string; reason: string };

  const result = resolveNetwork(input.manifest, input.query);

  if ("resolved" in expected) {
    if (!("resolved" in result)) {
      throw new Error(
        `Expected ${input.query} to resolve to ${expected.resolved}, but it failed: ${result.message}`,
      );
    }
    expect(result.resolved).toBe(expected.resolved);
    expect(result.wasAlias).toBe(expected.wasAlias);
    return;
  }

  if ("resolved" in result) {
    throw new Error(
      `Expected ${input.query} to be rejected, but it resolved to ${result.resolved}`,
    );
  }
  expect(result.reason).toBe(expected.reason);
  expect(MANIFEST_ERROR_CODE).toBe(expected.errorCode);
});

registerHandler("protocol.decode-payment-required", (vector: ConformanceVector) => {
  const input = vector.input as {
    requestUrl: string;
    requestMethod: string;
    header?: string;
    generatedHeader?: { kind: "repeated-ascii"; decodedBytes: number };
    clockEpochMs: number;
  };
  const expected = vector.expected as
    | { outcome: "valid"; normalized: unknown }
    | { outcome: "invalid"; errorCode: string; reason: string };

  try {
    const header = input.generatedHeader
      ? Buffer.alloc(input.generatedHeader.decodedBytes, 0x78).toString("base64")
      : input.header;
    const normalized = decodePaymentRequired(header, {
      requestUrl: input.requestUrl,
      requestMethod: input.requestMethod,
      requestId: vector.id,
      clockEpochMs: input.clockEpochMs,
    });
    if (expected.outcome === "invalid") {
      throw new Error(`Expected decode to fail with ${expected.reason}, but it succeeded`);
    }
    expect(normalized).toEqual(expected.normalized);
  } catch (error) {
    if (expected.outcome === "valid") throw error;
    if (!isTx402Error(error)) throw error;
    expect(error.code).toBe(expected.errorCode);
    expect(error.details.reason).toBe(expected.reason);
  }
});

registerHandler("request.fingerprint", (vector: ConformanceVector) => {
  const input = vector.input as {
    method: string;
    url: string;
    body: string | null;
    challengeHash: string;
  };
  const expected = vector.expected as {
    normalizedUrl: string;
    bodyHash: string;
    fingerprint: string;
  };
  expect(normalizeFingerprintUrl(input.url)).toBe(expected.normalizedUrl);
  expect(digestRequestBody(input.body)).toBe(expected.bodyHash);
  expect(
    fingerprintRequest({
      method: input.method,
      url: input.url,
      body: input.body,
      challengeHash: input.challengeHash,
    }),
  ).toBe(expected.fingerprint);
});

registerHandler("spend-ledger.behavior", async (vector: ConformanceVector) => {
  const input = vector.input as { operations: Record<string, unknown>[] };
  const expected = vector.expected as { outcomes: unknown[] };
  const store = new MemorySpendStore();
  const outcomes: Record<string, unknown>[] = [];
  for (const operation of input.operations) {
    try {
      switch (operation.action) {
        case "reserve": {
          const reservation = await store.reserve(operation as never);
          outcomes.push({ outcome: "reserved", state: reservation.state });
          break;
        }
        case "commit": {
          await store.commit(operation as never);
          outcomes.push({ outcome: "committed" });
          break;
        }
        case "release": {
          const reservation = await store.release(
            operation.reservationId as string,
            operation.nowEpochMs as number,
          );
          outcomes.push({ outcome: "released", state: reservation.state });
          break;
        }
        case "snapshot": {
          const state = await store.getBudgetState(operation as never);
          outcomes.push({
            outcome: "snapshot",
            committedAtomic: state.committedAtomic,
            reservedAtomic: state.reservedAtomic,
            reservationStates: state.reservations.map((item) => item.state),
            entryCount: state.entries.length,
          });
          break;
        }
        default:
          throw new Error(`Unknown ledger operation ${String(operation.action)}`);
      }
    } catch (error) {
      if (!isTx402Error(error)) throw error;
      outcomes.push({ outcome: "error", errorCode: error.code });
    }
  }
  expect(outcomes).toEqual(expected.outcomes);
});

registerHandler("evm.authorization-plan", (vector: ConformanceVector) => {
  const input = vector.input as {
    networkId: string;
    requirement: ExactEvmRequirementInput;
    payer: string;
    nowEpochMs: number;
    maxAuthorizationSeconds?: number;
  };
  const expected = vector.expected as {
    outcome: "valid" | "invalid";
    plan?: Record<string, unknown>;
    errorCode?: string;
    reason?: string;
  };

  // The network and asset are resolved from the bundled manifest rather than carried in the
  // vector, so the fixture pins that lookup too — SPEC §0 admits chain and token data through
  // the signed manifest and nowhere else.
  const network = BUNDLED_MANIFEST.networks[input.networkId] as EvmManifestNetwork;
  const asset =
    network.assets.find(
      (candidate) =>
        candidate.address.toLowerCase() === input.requirement.asset.toLowerCase(),
    ) ?? network.assets[0];
  // Vectors that name an off-manifest token still need an asset to be rejected against.
  if (asset === undefined) throw new Error(`${input.networkId} declares no assets`);

  const run = () =>
    planExactEvmAuthorization({
      requirement: input.requirement,
      networkId: input.networkId,
      network,
      asset,
      payer: input.payer,
      nowEpochMs: input.nowEpochMs,
      maxAuthorizationSeconds: input.maxAuthorizationSeconds ?? 60,
      context: { requestId: vector.id, phase: "route" },
    });

  if (expected.outcome === "valid") {
    expect({ ...run() }).toEqual(expected.plan);
    return;
  }
  try {
    run();
    expect.unreachable(`${vector.id} should have been rejected`);
  } catch (error) {
    if (!isTx402Error(error)) throw error;
    expect({ errorCode: error.code, reason: error.details.reason }).toEqual({
      errorCode: expected.errorCode,
      reason: expected.reason,
    });
  }
});
