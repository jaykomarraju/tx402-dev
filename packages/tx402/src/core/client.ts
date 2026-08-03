/** WHATWG transport shell through the first 402 (M1, SPEC §6.1–§6.2). */

import { randomBytes } from "node:crypto";

import { BUNDLED_MANIFEST } from "./bundled-manifest.js";
import {
  ConfigurationError,
  InvalidPaymentRequiredError,
  NonReplayableRequestError,
  PaidRedirectBlockedError,
  ReservedHeaderError,
  TransportError,
  isTx402Error,
} from "./errors.js";
import { MemorySpendStore, type BudgetState, type SpendStore } from "./ledger.js";
import { assertValidReleaseManifest, type ReleaseManifest } from "./manifest.js";
import { PolicyEngine, type PolicyConfig, type RoutingPolicyConfig } from "./policy.js";
import { decodePaymentRequired, type NormalizedPaymentRequired } from "./protocol.js";
import { PROTOCOL_HEADERS, RESERVED_REQUEST_HEADERS } from "../meta.js";

export interface Tx402Logger {
  debug(event: Readonly<Record<string, unknown>>): void;
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
  error(event: Readonly<Record<string, unknown>>): void;
}

export interface Tx402Clock {
  now(): number;
  monotonic(): number;
}

export interface Tx402ClientConfig {
  readonly signers?: Readonly<{ evm?: unknown; solana?: unknown }>;
  readonly policy?: PolicyConfig;
  readonly timeouts?: Readonly<Record<string, unknown>>;
  readonly routing?: RoutingPolicyConfig;
  readonly spendStore?: SpendStore;
  readonly manifest?: ReleaseManifest;
  readonly logger?: Tx402Logger;
  readonly clock?: Tx402Clock;
  readonly allowInsecureLocalhost?: boolean;
}

export interface Tx402RequestInit extends RequestInit {
  /** Creates a fresh body for each transmission. Required for caller-owned streams. */
  readonly bodyFactory?: () => RequestInit["body"] | Promise<RequestInit["body"]>;
}

export type Tx402RequestInfo = string | URL | Request;

export interface PaymentInspection {
  readonly requestId: string;
  readonly response: Response;
  readonly paymentRequired?: NormalizedPaymentRequired;
}

export interface Tx402Client {
  fetch(input: Tx402RequestInfo, init?: Tx402RequestInit): Promise<Response>;
  inspect(input: Tx402RequestInfo, init?: Tx402RequestInit): Promise<PaymentInspection>;
  getBudgetState(): BudgetState;
  resetHealth(): void;
}

const NOOP_LOGGER: Tx402Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

const SYSTEM_CLOCK: Tx402Clock = Object.freeze({
  now: () => Date.now(),
  monotonic: () => performance.now(),
});

function uuidV7(nowEpochMs: number): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Math.trunc(nowEpochMs));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function context(requestId: string, phase: "initial" | "parse" | "retry") {
  return { requestId, phase } as const;
}

function emit(
  logger: Tx402Logger,
  level: keyof Tx402Logger,
  event: Readonly<Record<string, unknown>>,
): void {
  // Application diagnostics must never turn a successful HTTP operation into a failure.
  try {
    logger[level](Object.freeze({ ...event }));
  } catch {
    // Logger failures are deliberately isolated. No console fallback (SPEC §10).
  }
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function assertSafeUrl(url: URL, allowInsecureLocalhost: boolean, requestId: string): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && allowInsecureLocalhost && isLocalhost(url.hostname))
    return;
  throw new ConfigurationError("Resource URL must use HTTPS", {
    context: context(requestId, "initial"),
    details: { configPath: "input", reason: "https-required" },
  });
}

function assertNoReservedHeaders(headers: Headers, requestId: string): void {
  for (const name of RESERVED_REQUEST_HEADERS) {
    if (headers.has(name)) {
      throw new ReservedHeaderError(`Caller supplied reserved header ${name}`, {
        context: context(requestId, "initial"),
        details: { headerName: name },
      });
    }
  }
}

function requestUrl(input: Tx402RequestInfo): URL {
  return new URL(input instanceof Request ? input.url : input);
}

async function prepareRequest(
  input: Tx402RequestInfo,
  init: Tx402RequestInit | undefined,
  allowInsecureLocalhost: boolean,
  requestId: string,
): Promise<Request> {
  const url = requestUrl(input);
  assertSafeUrl(url, allowInsecureLocalhost, requestId);

  const { bodyFactory, ...nativeInit } = init ?? {};
  const directBody = nativeInit.body;
  if (directBody instanceof ReadableStream && bodyFactory === undefined) {
    throw new NonReplayableRequestError("Streaming request body requires bodyFactory", {
      context: context(requestId, "initial"),
      details: { reason: "streaming-body-without-factory" },
    });
  }

  let body = directBody;
  if (bodyFactory !== undefined) {
    try {
      body = await bodyFactory();
    } catch (error) {
      throw new NonReplayableRequestError("bodyFactory failed before the initial request", {
        context: context(requestId, "initial"),
        details: { reason: "body-factory-failed" },
        cause: error,
      });
    }
  }

  const requestInit: RequestInit = {
    ...nativeInit,
    ...(body === undefined ? {} : { body }),
  };
  // Node's fetch requires this for a stream supplied by a bodyFactory. It is harmless in
  // runtimes that ignore the non-standard construction hint.
  if (body instanceof ReadableStream) {
    (requestInit as RequestInit & { duplex: "half" }).duplex = "half";
  }

  let request: Request;
  try {
    request = new Request(input, requestInit);
    // Capturing a clone now proves all ordinary bodies can be replayed later. The clone is
    // intentionally discarded at M1; M6 consumes the same seam for the signed retry.
    if (request.body !== null && bodyFactory === undefined) request.clone();
  } catch (error) {
    throw new NonReplayableRequestError("Request body cannot be captured for replay", {
      context: context(requestId, "initial"),
      details: { reason: "body-capture-failed" },
      cause: error,
    });
  }
  assertNoReservedHeaders(request.headers, requestId);
  return request;
}

async function issueInitial(request: Request, requestId: string): Promise<Response> {
  try {
    return await globalThis.fetch(request);
  } catch (error) {
    if (isTx402Error(error)) throw error;
    throw new TransportError("Initial resource request failed", {
      context: context(requestId, "initial"),
      details: { causeCategory: "network" },
      cause: error,
    });
  }
}

/**
 * Future paid-retry transport seam. Redirects are exposed manually and rejected before a
 * signature-bearing follow-up could cross an origin boundary (SEC-005).
 */
export async function issuePaidRetry(
  request: Request,
  requestId: string,
  transport: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  let response: Response;
  try {
    response = await transport(new Request(request, { redirect: "manual" }));
  } catch (error) {
    throw new TransportError("Paid resource retry failed", {
      context: context(requestId, "retry"),
      details: { causeCategory: "network" },
      cause: error,
    });
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (location !== null) {
      const destination = new URL(location, request.url);
      const source = new URL(request.url);
      if (destination.origin !== source.origin) {
        throw new PaidRedirectBlockedError("Paid retry redirect crossed origins", {
          context: context(requestId, "retry"),
          details: { fromOrigin: source.origin, toOrigin: destination.origin },
        });
      }
    }
  }
  return response;
}

/** Construct an immutable M1 client and validate configuration synchronously. */
export function createTx402Client(config: Tx402ClientConfig = {}): Tx402Client {
  if (
    config.allowInsecureLocalhost !== undefined &&
    typeof config.allowInsecureLocalhost !== "boolean"
  ) {
    throw new ConfigurationError("allowInsecureLocalhost must be boolean", {
      context: context("configuration", "initial"),
      details: { configPath: "allowInsecureLocalhost", reason: "expected-boolean" },
    });
  }
  const manifest = config.manifest ?? BUNDLED_MANIFEST;
  assertValidReleaseManifest(manifest, {
    nowEpochMs: config.clock?.now() ?? Date.now(),
    context: context("configuration", "initial"),
  });
  const logger = config.logger ?? NOOP_LOGGER;
  const clock = config.clock ?? SYSTEM_CLOCK;
  const allowInsecureLocalhost = config.allowInsecureLocalhost ?? false;
  const spendStore = config.spendStore ?? new MemorySpendStore();
  if (
    typeof spendStore !== "object" ||
    spendStore === null ||
    typeof spendStore.kind !== "string" ||
    typeof spendStore.reserve !== "function" ||
    typeof spendStore.commit !== "function" ||
    typeof spendStore.release !== "function" ||
    typeof spendStore.getBudgetState !== "function"
  ) {
    throw new ConfigurationError("spendStore must implement the SpendStore contract", {
      context: context("configuration", "initial"),
      details: { configPath: "spendStore", reason: "invalid-spend-store" },
    });
  }
  const policyEngine = new PolicyEngine(manifest, config.policy, config.routing);
  const policyScope = uuidV7(clock.now());
  let budgetState: BudgetState = Object.freeze({
    storeKind: spendStore.kind,
    committedAtomic: "0",
    reservedAtomic: "0",
    entries: Object.freeze([]),
    reservations: Object.freeze([]),
  });

  const inspect = async (
    input: Tx402RequestInfo,
    init?: Tx402RequestInit,
  ): Promise<PaymentInspection> => {
    const started = clock.monotonic();
    const requestId = uuidV7(clock.now());
    let request: Request | undefined;
    try {
      request = await prepareRequest(input, init, allowInsecureLocalhost, requestId);
      policyEngine.assertDomain(request.url, requestId, "initial");
      emit(logger, "info", {
        event: "request.started",
        requestId,
        method: request.method,
        normalizedHost: new URL(request.url).hostname,
      });
      const response = await issueInitial(request, requestId);
      if (response.status !== 402) return Object.freeze({ requestId, response });

      const paymentRequired = decodePaymentRequired(
        response.headers.get(PROTOCOL_HEADERS.paymentRequired),
        {
          requestUrl: request.url,
          requestMethod: request.method,
          requestId,
          clockEpochMs: clock.now(),
          allowInsecureLocalhost,
        },
      );
      emit(logger, "info", {
        event: "payment.required",
        requestId,
        requirementCount: paymentRequired.requirements.length,
        headerHash: paymentRequired.headerHash,
        totalSdkOverheadMs: Math.max(0, clock.monotonic() - started),
      });
      return Object.freeze({ requestId, response, paymentRequired });
    } catch (error) {
      const typed = isTx402Error(error)
        ? error
        : new TransportError("Request inspection failed", {
            context: context(requestId, request === undefined ? "initial" : "parse"),
            details: { causeCategory: "runtime" },
            cause: error,
          });
      emit(logger, "error", {
        event: "request.failed",
        requestId,
        errorCode: typed.code,
        phase: typed.context.phase,
        paid: typed.context.paid ?? false,
      });
      throw typed;
    }
  };

  const client: Tx402Client = {
    inspect,
    async fetch(input, init) {
      const inspection = await inspect(input, init);
      if (inspection.paymentRequired === undefined) return inspection.response;

      const decision = await policyEngine.evaluate(inspection.paymentRequired, {
        requestId: inspection.requestId,
        policyScope,
        nowEpochMs: clock.now(),
        spendStore,
      });
      const first = decision.requirements[0];
      if (first !== undefined) {
        budgetState = await spendStore.getBudgetState({
          policyScope,
          assetId: first.assetId,
          nowEpochMs: clock.now(),
        });
      }
      emit(logger, "info", {
        event: "policy.checked",
        requestId: inspection.requestId,
        outcome: "allowed",
        policyCode: "allowed",
      });

      // M1 stops at the validated first challenge. Later milestones replace this return
      // with policy, routing, reservation, signing, and the paid retry.
      return inspection.response;
    },
    getBudgetState: () => budgetState,
    resetHealth: () => undefined,
  };
  return Object.freeze(client);
}

/** Narrow helper used by tests and future adapters without exposing raw challenge bytes. */
export function paymentRequiredReason(error: unknown): string | undefined {
  return error instanceof InvalidPaymentRequiredError &&
    typeof error.details.reason === "string"
    ? error.details.reason
    : undefined;
}

export type { BudgetState } from "./ledger.js";
