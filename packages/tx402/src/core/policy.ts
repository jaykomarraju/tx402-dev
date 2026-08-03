/** Local policy evaluation in the exact SPEC §6.3 order. */

import {
  BudgetExceededError,
  ClockSkewError,
  ConfigurationError,
  DomainNotAllowedError,
  InvalidPaymentRequiredError,
  UnsupportedSchemeError,
  type Tx402ErrorContext,
} from "./errors.js";
import type { SpendStore } from "./ledger.js";
import {
  requireNetwork,
  type ManifestAsset,
  type ManifestNetwork,
  type ReleaseManifest,
} from "./manifest.js";
import { MoneyParseError, parsePositiveMoneyAtomic } from "./money.js";
import type {
  NormalizedPaymentRequired,
  NormalizedPaymentRequirement,
} from "./protocol.js";

export interface PolicyConfig {
  readonly maxPerRequest?: unknown;
  readonly maxPerHour?: unknown;
  readonly allowedNetworks?: readonly string[];
  readonly allowedDomains?: readonly string[];
  readonly maxPaidAttempts?: number;
}

export interface RoutingPolicyConfig {
  readonly maxQuoteAgeMs?: number;
}

export interface PolicyRequirement extends NormalizedPaymentRequirement {
  readonly assetId: string;
  /**
   * The **manifest** asset this requirement was matched to — decimals, symbol, and the
   * canonical address — not the merchant's claim about it. Route planning and the signer
   * presentation read token metadata from here, so a merchant cannot restate a token's
   * decimals and change what an amount means (SPEC §0, ADR-006).
   */
  readonly manifestAsset: ManifestAsset;
  readonly maxPerRequestAtomic: string;
  readonly maxPerHourAtomic: string;
}

export interface PolicyDecision {
  readonly normalizedHost: string;
  readonly requirements: readonly PolicyRequirement[];
}

interface PreparedAsset {
  readonly manifest: ManifestAsset;
  readonly assetId: string;
  readonly maxPerRequest: bigint;
  readonly maxPerHour: bigint;
}

const DEFAULT_MAX_PER_REQUEST = "0.50 USDC";
const DEFAULT_MAX_PER_HOUR = "10.00 USDC";
const DEFAULT_MAX_QUOTE_AGE_MS = 5_000;
const MAX_FUTURE_SKEW_MS = 15_000;

function configContext(): Tx402ErrorContext {
  return { requestId: "configuration", phase: "initial" };
}

function configuration(path: string, reason: string, cause?: unknown): ConfigurationError {
  return new ConfigurationError(`Invalid ${path}: ${reason}`, {
    context: configContext(),
    details: { configPath: path, reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

export function normalizePolicyHost(url: string | URL): string {
  return new URL(url).hostname.toLowerCase().replace(/\.$/u, "");
}

function normalizeDomainPattern(value: string, index: number): string {
  if (value === "*") return value;
  const wildcard = value.startsWith("*.");
  const candidate = wildcard ? value.slice(2) : value;
  if (
    candidate.length === 0 ||
    candidate.includes(":") ||
    candidate.includes("/") ||
    candidate.includes("@")
  ) {
    throw configuration(`policy.allowedDomains[${index}]`, "invalid-domain-pattern");
  }
  let host: string;
  try {
    host = new URL(`https://${candidate}`).hostname.toLowerCase().replace(/\.$/u, "");
  } catch (error) {
    throw configuration(`policy.allowedDomains[${index}]`, "invalid-domain-pattern", error);
  }
  return wildcard ? `*.${host}` : host;
}

function domainMatches(host: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.startsWith("*.")) return host === pattern;
  const suffix = pattern.slice(1);
  return host.endsWith(suffix) && host.length > suffix.length;
}

function isEvmNetwork(network: ManifestNetwork): boolean {
  return "chainId" in network;
}

function assetReference(asset: ManifestAsset): string {
  return "address" in asset ? asset.address : asset.mint;
}

function assetMatches(
  network: ManifestNetwork,
  asset: ManifestAsset,
  offered: string,
): boolean {
  const expected = assetReference(asset);
  return isEvmNetwork(network)
    ? expected.toLowerCase() === offered.toLowerCase()
    : expected === offered;
}

function assetId(
  networkId: string,
  network: ManifestNetwork,
  asset: ManifestAsset,
): string {
  return `${networkId}/${isEvmNetwork(network) ? "erc20" : "token"}:${assetReference(asset)}`;
}

function timestampFromExtra(extra: Readonly<Record<string, unknown>>): number | undefined {
  if (!("timestamp" in extra)) return undefined;
  const value = extra.timestamp;
  if (typeof value === "string" && value.endsWith("Z")) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new TypeError("quote-timestamp-invalid");
}

/** Immutable policy object. It performs no network or signer calls. */
export class PolicyEngine {
  readonly #manifest: ReleaseManifest;
  readonly #allowedNetworks: ReadonlySet<string>;
  readonly #allowedDomains: readonly string[];
  readonly #assets = new Map<string, PreparedAsset>();
  readonly #maxQuoteAgeMs: number;
  readonly maxPaidAttempts: number;

  constructor(
    manifest: ReleaseManifest,
    policy: PolicyConfig = {},
    routing: RoutingPolicyConfig = {},
  ) {
    this.#manifest = manifest;
    const configuredNetworks =
      policy.allowedNetworks ??
      Object.entries(manifest.networks)
        .filter(([, network]) => network.environment === "production")
        .map(([networkId]) => networkId);
    if (!Array.isArray(configuredNetworks) || configuredNetworks.length === 0) {
      throw configuration("policy.allowedNetworks", "empty-list");
    }
    const resolvedNetworks = configuredNetworks.map((network, index) => {
      if (typeof network !== "string") {
        throw configuration(`policy.allowedNetworks[${index}]`, "expected-string");
      }
      return requireNetwork(
        manifest,
        network,
        configContext(),
        `policy.allowedNetworks[${index}]`,
      );
    });
    this.#allowedNetworks = new Set(resolvedNetworks);

    const configuredDomains = policy.allowedDomains ?? ["*"];
    if (!Array.isArray(configuredDomains) || configuredDomains.length === 0) {
      throw configuration("policy.allowedDomains", "empty-list");
    }
    this.#allowedDomains = Object.freeze(
      configuredDomains.map((pattern, index) => {
        if (typeof pattern !== "string") {
          throw configuration(`policy.allowedDomains[${index}]`, "expected-string");
        }
        return normalizeDomainPattern(pattern, index);
      }),
    );

    this.maxPaidAttempts = policy.maxPaidAttempts ?? 2;
    if (
      !Number.isInteger(this.maxPaidAttempts) ||
      this.maxPaidAttempts < 1 ||
      this.maxPaidAttempts > 3
    ) {
      throw configuration("policy.maxPaidAttempts", "integer-out-of-range");
    }
    this.#maxQuoteAgeMs = routing.maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
    if (!Number.isInteger(this.#maxQuoteAgeMs) || this.#maxQuoteAgeMs < 0) {
      throw configuration("routing.maxQuoteAgeMs", "expected-non-negative-integer");
    }

    for (const networkId of this.#allowedNetworks) {
      const network = manifest.networks[networkId];
      if (network === undefined) continue;
      for (const asset of network.assets) {
        let maxPerRequest: bigint;
        let maxPerHour: bigint;
        try {
          maxPerRequest = parsePositiveMoneyAtomic(
            policy.maxPerRequest ?? DEFAULT_MAX_PER_REQUEST,
            asset,
          );
        } catch (error) {
          const reason = error instanceof MoneyParseError ? error.reason : "invalid-money";
          throw configuration("policy.maxPerRequest", reason, error);
        }
        try {
          maxPerHour = parsePositiveMoneyAtomic(
            policy.maxPerHour ?? DEFAULT_MAX_PER_HOUR,
            asset,
          );
        } catch (error) {
          const reason = error instanceof MoneyParseError ? error.reason : "invalid-money";
          throw configuration("policy.maxPerHour", reason, error);
        }
        if (maxPerHour < maxPerRequest) {
          throw configuration("policy.maxPerHour", "below-max-per-request");
        }
        this.#assets.set(`${networkId}\u0000${assetReference(asset)}`, {
          manifest: asset,
          assetId: assetId(networkId, network, asset),
          maxPerRequest,
          maxPerHour,
        });
      }
    }
    Object.freeze(this);
  }

  assertDomain(url: string | URL, requestId: string, phase: "initial" | "policy"): string {
    const host = normalizePolicyHost(url);
    if (!this.#allowedDomains.some((pattern) => domainMatches(host, pattern))) {
      throw new DomainNotAllowedError("Destination domain is not allowed", {
        context: { requestId, phase },
        details: { normalizedHost: host },
      });
    }
    return host;
  }

  async evaluate(
    paymentRequired: NormalizedPaymentRequired,
    options: {
      readonly requestId: string;
      readonly policyScope: string;
      readonly nowEpochMs: number;
      readonly spendStore: SpendStore;
    },
  ): Promise<PolicyDecision> {
    const context: Tx402ErrorContext = { requestId: options.requestId, phase: "policy" };

    // 7. Destination domain.
    const normalizedHost = this.assertDomain(
      paymentRequired.resource.url,
      options.requestId,
      "policy",
    );

    // 8. Supported and allowed networks.
    const networkAllowed = paymentRequired.requirements.filter(
      (requirement) =>
        this.#allowedNetworks.has(requirement.network) &&
        this.#manifest.networks[requirement.network] !== undefined,
    );
    if (networkAllowed.length === 0) {
      throw new UnsupportedSchemeError("No allowed payment network was offered", {
        context,
        details: {
          offeredSchemes: [
            ...new Set(paymentRequired.requirements.map((item) => item.scheme)),
          ],
          offeredNetworks: [
            ...new Set(paymentRequired.requirements.map((item) => item.network)),
          ],
        },
      });
    }

    // 9. Supported schemes and manifest assets.
    const supported: { requirement: NormalizedPaymentRequirement; asset: PreparedAsset }[] =
      [];
    for (const requirement of networkAllowed) {
      const network = this.#manifest.networks[requirement.network];
      if (network === undefined || requirement.scheme !== "exact") continue;
      const matched = network.assets.find(
        (asset) =>
          asset.schemes.includes(requirement.scheme) &&
          assetMatches(network, asset, requirement.asset),
      );
      if (matched === undefined) continue;
      const prepared = this.#assets.get(
        `${requirement.network}\u0000${assetReference(matched)}`,
      );
      if (prepared !== undefined) supported.push({ requirement, asset: prepared });
    }
    if (supported.length === 0) {
      throw new UnsupportedSchemeError(
        "No supported payment scheme and asset was offered",
        {
          context,
          details: {
            offeredSchemes: [...new Set(networkAllowed.map((item) => item.scheme))],
            offeredNetworks: [...new Set(networkAllowed.map((item) => item.network))],
          },
        },
      );
    }

    // 10. Per-request amount.
    const underRequestCap = supported.filter(
      ({ requirement, asset }) => BigInt(requirement.amountAtomic) <= asset.maxPerRequest,
    );
    if (underRequestCap.length === 0) {
      const { requirement, asset } = supported.reduce((best, candidate) =>
        BigInt(candidate.requirement.amountAtomic) < BigInt(best.requirement.amountAtomic)
          ? candidate
          : best,
      );
      throw new BudgetExceededError("Payment exceeds the per-request limit", {
        context: {
          ...context,
          network: requirement.network,
          scheme: requirement.scheme,
          amountAtomic: requirement.amountAtomic,
          assetId: asset.assetId,
        },
        details: {
          requestedAtomic: requirement.amountAtomic,
          capAtomic: asset.maxPerRequest.toString(),
          committedAtomic: "0",
          reservedAtomic: "0",
          capKind: "per-request",
        },
      });
    }

    // 11. Rolling committed plus active reservations. Atomic reserve repeats this check.
    const withinHourlyCap: PolicyRequirement[] = [];
    let lastBudget:
      | {
          requirement: NormalizedPaymentRequirement;
          asset: PreparedAsset;
          committedAtomic: string;
          reservedAtomic: string;
        }
      | undefined;
    for (const { requirement, asset } of underRequestCap) {
      const state = await options.spendStore.getBudgetState({
        policyScope: options.policyScope,
        assetId: asset.assetId,
        nowEpochMs: options.nowEpochMs,
      });
      lastBudget = {
        requirement,
        asset,
        committedAtomic: state.committedAtomic,
        reservedAtomic: state.reservedAtomic,
      };
      if (
        BigInt(state.committedAtomic) +
          BigInt(state.reservedAtomic) +
          BigInt(requirement.amountAtomic) <=
        asset.maxPerHour
      ) {
        withinHourlyCap.push(
          Object.freeze({
            ...requirement,
            assetId: asset.assetId,
            manifestAsset: asset.manifest,
            maxPerRequestAtomic: asset.maxPerRequest.toString(),
            maxPerHourAtomic: asset.maxPerHour.toString(),
          }),
        );
      }
    }
    if (withinHourlyCap.length === 0 && lastBudget !== undefined) {
      throw new BudgetExceededError("Payment would exceed the rolling hourly limit", {
        context: {
          ...context,
          network: lastBudget.requirement.network,
          scheme: lastBudget.requirement.scheme,
          amountAtomic: lastBudget.requirement.amountAtomic,
          assetId: lastBudget.asset.assetId,
        },
        details: {
          requestedAtomic: lastBudget.requirement.amountAtomic,
          capAtomic: lastBudget.asset.maxPerHour.toString(),
          committedAtomic: lastBudget.committedAtomic,
          reservedAtomic: lastBudget.reservedAtomic,
          capKind: "per-hour",
        },
      });
    }

    // 12. Conditional quote timestamp in upstream `extra` (ADR-010 decision 3).
    const fresh = withinHourlyCap.filter((requirement) => {
      let timestamp: number | undefined;
      try {
        timestamp = timestampFromExtra(requirement.extra);
      } catch (error) {
        throw new InvalidPaymentRequiredError("Quote timestamp is invalid", {
          context,
          details: {
            reason: "quote-timestamp-invalid",
            schemaPath: "/accepts/*/extra/timestamp",
          },
          cause: error,
        });
      }
      if (timestamp === undefined) return true;
      const skew = timestamp - options.nowEpochMs;
      if (skew > MAX_FUTURE_SKEW_MS) {
        throw new ClockSkewError("Quote timestamp is unreasonably future-dated", {
          context,
          details: { observedSkewMs: skew, thresholdMs: MAX_FUTURE_SKEW_MS },
        });
      }
      return options.nowEpochMs - timestamp <= this.#maxQuoteAgeMs;
    });
    if (fresh.length === 0) {
      throw new InvalidPaymentRequiredError("Payment quote has expired", {
        context,
        details: { reason: "quote-expired", schemaPath: "/accepts/*/extra/timestamp" },
      });
    }

    return Object.freeze({
      normalizedHost,
      requirements: Object.freeze(fresh),
    });
  }
}
