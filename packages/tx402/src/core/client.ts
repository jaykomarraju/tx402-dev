/**
 * The request execution state machine (SPEC §6).
 *
 * The ordering in {@link executePayment} is the security-critical part of this file and is
 * not an implementation detail:
 *
 *   parse → policy → plan → **reserve** → sign → retry → commit
 *
 * SEC-002 requires every policy check and the budget reservation to complete before a signer
 * is invoked, and SPEC §6.6 requires the reservation to exist before signing. Both are
 * enforced structurally here — the adapter that can sign is not reachable until the
 * reservation has been written — rather than by a comment asking future edits to be careful.
 *
 * The other rule that shapes the code is SPEC §6.7's asymmetry after a signature is
 * transmitted. Before transmission, a failure releases the reservation. After transmission,
 * the outcome may be a settled payment tx402 never saw, so the reservation is **retained**
 * until its TTL and the caller gets `AmbiguousPaymentError`. Releasing there would let the
 * same money be spent twice against the hourly cap.
 */

import { createHash, randomBytes } from "node:crypto";

import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";

import { BUNDLED_MANIFEST } from "./bundled-manifest.js";
import {
  chainFamily,
  loadChainAdapter,
  MAX_AUTHORIZATION_SECONDS,
  type ChainAdapter,
  type ChainRoute,
} from "./chain.js";
import {
  AmbiguousPaymentError,
  ConfigurationError,
  InsufficientLiquidityError,
  InvalidPaymentRequiredError,
  NonReplayableRequestError,
  PaidRedirectBlockedError,
  ReservedHeaderError,
  ResourceDeliveryError,
  TransportError,
  UnsupportedSchemeError,
  isTx402Error,
  type Tx402ErrorContext,
} from "./errors.js";
import { fingerprintRequest } from "./fingerprint.js";
import {
  MemorySpendStore,
  type BudgetState,
  type SpendReservation,
  type SpendStore,
} from "./ledger.js";
import { assertValidReleaseManifest, type ReleaseManifest } from "./manifest.js";
import {
  PolicyEngine,
  normalizePolicyHost,
  type PolicyConfig,
  type PolicyRequirement,
  type RoutingPolicyConfig,
} from "./policy.js";
import { decodePaymentRequired, type NormalizedPaymentRequired } from "./protocol.js";
import type { Tx402Signers } from "./signers.js";
import { PROTOCOL_HEADERS, REQUEST_ID_HEADER, RESERVED_REQUEST_HEADERS } from "../meta.js";

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

export interface Tx402Timeouts {
  /** Absent by default: SPEC §4.3 forbids silently shortening the caller's own timeout. */
  readonly initialRequestMs?: number;
  /** Covers the paid retry. Default 10 000 ms, minimum 1 000 (SPEC §4.3). */
  readonly paymentRetryMs?: number;
}

export interface Tx402ClientConfig {
  readonly signers?: Tx402Signers;
  readonly policy?: PolicyConfig;
  readonly timeouts?: Tx402Timeouts;
  readonly routing?: RoutingPolicyConfig;
  readonly spendStore?: SpendStore;
  readonly manifest?: ReleaseManifest;
  readonly logger?: Tx402Logger;
  readonly clock?: Tx402Clock;
  readonly allowInsecureLocalhost?: boolean;
  /**
   * Omits the `X-TX402-REQUEST-ID` diagnostic header from paid retries (SPEC §6.7). The
   * header is non-authoritative; strict integrations that reject unknown headers turn it off.
   */
  readonly disableRequestIdHeader?: boolean;
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

const DEFAULT_PAYMENT_RETRY_MS = 10_000;
const MIN_PAYMENT_RETRY_MS = 1_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

function context(requestId: string, phase: Tx402ErrorContext["phase"]): Tx402ErrorContext {
  return { requestId, phase };
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

/** An SDK deadline layered over the caller's own signal, plus its cleanup. */
interface Deadline {
  readonly signal: AbortSignal | undefined;
  /**
   * Rejects when the deadline expires. **This is what enforces it**, not the signal.
   *
   * The signal is still passed down so the socket is torn down, but a signal alone cannot be
   * relied on: see the note on {@link withDeadline}.
   */
  readonly expired: Promise<never> | undefined;
  dispose(): void;
}

/**
 * Combines a caller signal with an SDK deadline without shortening the caller's own.
 *
 * **A deadline may not be entrusted to an `AbortSignal`.** Two separate mechanisms in the
 * platform drop it on the floor, and both were found the hard way:
 *
 *  1. `AbortSignal.any([signal, AbortSignal.timeout(ms)])` — the obvious spelling — holds its
 *     source signals *weakly*, and `AbortSignal.timeout` unrefs its timer. Once the helper
 *     returns, nothing strongly references the timeout signal; collect it and the deadline
 *     never fires. Measured against a hanging server under forced collection: 10 misses in 10.
 *  2. Even with the timer held strongly, `new Request(input)` does not share `input`'s signal —
 *     it creates a new one that *follows* it through a **`WeakRef` to the intermediate
 *     controller**. The request path builds several Requests in sequence (add the signature
 *     header, set `redirect: "manual"`, whatever a caller's transport wrapper does), and if any
 *     intermediate Request is collected, the follow chain breaks silently from that link on.
 *
 * So the signal is passed down as a courtesy — it is what actually tears the socket down — and
 * `expired` is what *enforces* the deadline, in tx402's own control flow, where nothing can
 * collect it. The caller races the two.
 *
 * Why this matters beyond a flaky test: a paid retry to a merchant that accepts the connection
 * and never answers would hang forever instead of raising `AmbiguousPaymentError`, which is the
 * one outcome SPEC §6.7 most needs reported — silence exactly where money may already have
 * moved.
 *
 * By contrast a **bare** `AbortSignal.timeout` handed straight to a single `fetch` is fine —
 * the `Request` references it strongly and there is no follow chain — which is why
 * `evm/rpc.ts` can keep using one for its per-provider budget.
 */
function withDeadline(signal: AbortSignal | null, timeoutMs?: number): Deadline {
  if (timeoutMs === undefined) {
    return { signal: signal ?? undefined, expired: undefined, dispose: () => undefined };
  }

  const controller = new AbortController();
  let expire!: () => void;
  const expired = new Promise<never>((_resolve, reject) => {
    expire = () => {
      const reason = new Error(`tx402 deadline of ${timeoutMs} ms exceeded`);
      // Matches what `AbortSignal.timeout` reports, so failure categorization is unchanged.
      reason.name = "TimeoutError";
      controller.abort(reason);
      reject(reason);
    };
  });
  // The race usually settles on the response instead, and a rejected promise nobody awaited
  // is an unhandled rejection. This keeps the loser quiet.
  expired.catch(() => undefined);

  const timer = setTimeout(expire, timeoutMs);
  // The in-flight request already keeps the loop alive; tx402 need not hold it open too.
  timer.unref();

  const forward = (): void => controller.abort(signal?.reason);
  if (signal !== null) {
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
  }

  return {
    signal: controller.signal,
    expired,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

/** Resolves the request, or rejects the moment the deadline expires — whichever comes first. */
async function raceDeadline<T>(work: Promise<T>, deadline: Deadline): Promise<T> {
  return deadline.expired === undefined ? work : Promise.race([work, deadline.expired]);
}

/**
 * The initial request, plus everything needed to reissue it byte-for-byte.
 *
 * SPEC §6.1 requires a replayable body representation to exist *before* the first send —
 * discovering after a 402 that the body cannot be replayed would mean the caller's stream
 * was already gone.
 */
interface PreparedRequest {
  readonly request: Request;
  readonly method: string;
  readonly url: string;
  readonly bodyBytes: Uint8Array | null;
  readonly bodyFactory: Tx402RequestInit["bodyFactory"];
}

async function prepareRequest(
  input: Tx402RequestInfo,
  init: Tx402RequestInit | undefined,
  allowInsecureLocalhost: boolean,
  requestId: string,
): Promise<PreparedRequest> {
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
  let bodyBytes: Uint8Array | null = null;
  try {
    request = new Request(input, requestInit);
    // Buffering a clone is the replayable representation. With a `bodyFactory` the caller
    // owns replay, so nothing is buffered and the factory is called again for the retry.
    if (request.body !== null && bodyFactory === undefined) {
      bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
    }
  } catch (error) {
    throw new NonReplayableRequestError("Request body cannot be captured for replay", {
      context: context(requestId, "initial"),
      details: { reason: "body-capture-failed" },
      cause: error,
    });
  }
  assertNoReservedHeaders(request.headers, requestId);
  return {
    request,
    method: request.method,
    url: request.url,
    bodyBytes,
    bodyFactory,
  };
}

async function issueInitial(
  request: Request,
  requestId: string,
  timeoutMs?: number,
): Promise<Response> {
  const deadline = withDeadline(request.signal, timeoutMs);
  try {
    return await raceDeadline(
      globalThis.fetch(
        deadline.signal === undefined || deadline.signal === request.signal
          ? request
          : new Request(request, { signal: deadline.signal }),
      ),
      deadline,
    );
  } catch (error) {
    if (isTx402Error(error)) throw error;
    throw new TransportError("Initial resource request failed", {
      context: context(requestId, "initial"),
      details: { causeCategory: "network" },
      cause: error,
    });
  } finally {
    deadline.dispose();
  }
}

/**
 * Sends the one signature-bearing attempt (SPEC §6.7).
 *
 * Redirects are surfaced manually rather than followed, so a cross-origin `Location` is
 * refused *before* a second request could carry the signature to another origin (SEC-005).
 */
export async function issuePaidRetry(
  request: Request,
  requestId: string,
  transport: typeof globalThis.fetch = globalThis.fetch,
  deadline?: Deadline,
): Promise<Response> {
  let response: Response;
  try {
    // Rebuilt only when it is not already manual: every extra `new Request` adds another
    // weakly-linked hop to the abort-follow chain (see `withDeadline`).
    const outbound =
      request.redirect === "manual"
        ? request
        : new Request(request, { redirect: "manual" });
    const sent = transport(outbound);
    response = await (deadline === undefined ? sent : raceDeadline(sent, deadline));
  } catch (error) {
    throw new TransportError("Paid resource retry failed", {
      context: context(requestId, "retry"),
      details: { causeCategory: "network" },
      cause: error,
    });
  }
  if (REDIRECT_STATUSES.has(response.status)) {
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

/* ------------------------------------------------------------------------------------- */
/* Payment execution                                                                       */
/* ------------------------------------------------------------------------------------- */

interface ClientRuntime {
  readonly manifest: ReleaseManifest;
  readonly policyEngine: PolicyEngine;
  readonly spendStore: SpendStore;
  readonly policyScope: string;
  readonly clock: Tx402Clock;
  readonly logger: Tx402Logger;
  readonly signers: Tx402Signers;
  readonly adapters: Map<string, Promise<ChainAdapter | undefined>>;
  readonly paymentRetryMs: number;
  readonly disableRequestIdHeader: boolean;
}

function signerFor(signers: Tx402Signers, family: string): unknown {
  if (family === "eip155") return signers.evm;
  if (family === "solana") return signers.solana;
  return undefined;
}

async function adapterFor(
  runtime: ClientRuntime,
  family: string,
  errorContext: Tx402ErrorContext,
): Promise<ChainAdapter | undefined> {
  let pending = runtime.adapters.get(family);
  if (pending === undefined) {
    pending = loadChainAdapter(family);
    runtime.adapters.set(family, pending);
  }
  try {
    return await pending;
  } catch (error) {
    // A missing optional peer dependency arrives here as a module resolution failure.
    runtime.adapters.delete(family);
    throw new ConfigurationError(
      `Paying on ${family} requires its optional chain adapter dependencies to be installed`,
      {
        context: errorContext,
        details: { configPath: `signers.${family}`, reason: "chain-adapter-unavailable" },
        cause: error,
      },
    );
  }
}

interface SelectedRoute {
  readonly route: ChainRoute;
  readonly requirement: PolicyRequirement;
  readonly adapter: ChainAdapter;
}

/**
 * Plans routes over the policy-approved requirements and picks one (SPEC §6.4).
 *
 * M3 orders by the merchant's requirement index and takes the first viable candidate. The
 * full ordering — preference rank, expected fee, health score, latency — arrives with the
 * RoutePlanner at M5. What is already true, and must stay true, is that ordering is a pure
 * function of the inputs: identical challenges plan identically (SPEC §6.4 step 19).
 */
async function planRoutes(
  runtime: ClientRuntime,
  requirements: readonly PolicyRequirement[],
  requestId: string,
  nowEpochMs: number,
): Promise<SelectedRoute> {
  const errorContext = context(requestId, "route");
  const candidates: SelectedRoute[] = [];
  const deficits: {
    network: string;
    assetId: string;
    required: string;
    available: string;
  }[] = [];
  let firstFailure: Error | undefined;
  let sawSigner = false;

  for (const requirement of requirements) {
    const family = chainFamily(requirement.network);
    const signer = signerFor(runtime.signers, family);
    if (signer === undefined) continue;

    const adapter = await adapterFor(runtime, family, errorContext);
    if (adapter === undefined) continue;
    sawSigner = true;

    const network = runtime.manifest.networks[requirement.network];
    if (network === undefined) continue;

    try {
      const route = await adapter.planRoute({
        requestId,
        networkId: requirement.network,
        network,
        asset: requirement.manifestAsset,
        requirement,
        signer,
        nowEpochMs,
      });
      if (route.viable) return { route, requirement, adapter };
      candidates.push({ route, requirement, adapter });
      deficits.push({
        network: route.networkId,
        assetId: route.assetId,
        required: route.amountAtomic,
        available: route.balanceAtomic,
      });
    } catch (error) {
      firstFailure ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!sawSigner) {
    throw new UnsupportedSchemeError(
      "No offered network has a configured signer and chain adapter",
      {
        context: errorContext,
        details: {
          offeredSchemes: [...new Set(requirements.map((item) => item.scheme))],
          offeredNetworks: [...new Set(requirements.map((item) => item.network))],
        },
      },
    );
  }
  if (candidates.length === 0 && firstFailure !== undefined) throw firstFailure;

  throw new InsufficientLiquidityError("No offered route has sufficient balance", {
    context: errorContext,
    details: { deficits },
  });
}

function settlementIdHash(settlementId: string): string {
  return `sha256:${createHash("sha256").update(settlementId, "utf8").digest("hex")}`;
}

/** Reads PAYMENT-RESPONSE, which upstream marks optional on a delivered resource. */
function readPaymentResponse(
  response: Response,
  requestId: string,
  logger: Tx402Logger,
): { success: boolean; settlementId?: string } | undefined {
  const header = response.headers.get(PROTOCOL_HEADERS.paymentResponse);
  if (header === null || header.length === 0) {
    emit(logger, "warn", {
      event: "payment.completed",
      requestId,
      paid: true,
      reason: "payment-response-absent",
    });
    return undefined;
  }
  try {
    const settle = decodePaymentResponseHeader(header);
    return {
      success: settle.success === true,
      ...(typeof settle.transaction === "string" && settle.transaction.length > 0
        ? { settlementId: settle.transaction }
        : {}),
    };
  } catch {
    // A response tx402 cannot parse is not evidence of anything, in either direction.
    emit(logger, "warn", {
      event: "payment.completed",
      requestId,
      paid: true,
      reason: "payment-response-unparseable",
    });
    return undefined;
  }
}

/**
 * Builds the one signature-bearing request, together with the deadline holding it.
 *
 * The `Deadline` comes back to the caller rather than staying here so its timer survives as a
 * live reference for the whole attempt and is cleared once the attempt settles.
 */
async function buildPaidRequest(
  prepared: PreparedRequest,
  signatureHeader: string,
  requestId: string,
  runtime: ClientRuntime,
): Promise<{ request: Request; deadline: Deadline }> {
  const headers = new Headers(prepared.request.headers);
  headers.set(PROTOCOL_HEADERS.paymentSignature, signatureHeader);
  if (!runtime.disableRequestIdHeader) headers.set(REQUEST_ID_HEADER, requestId);

  let body: RequestInit["body"] | undefined;
  if (prepared.bodyFactory !== undefined) {
    try {
      body = await prepared.bodyFactory();
    } catch (error) {
      throw new NonReplayableRequestError("bodyFactory failed before the paid retry", {
        context: context(requestId, "retry"),
        details: { reason: "body-factory-failed" },
        cause: error,
      });
    }
  } else if (prepared.bodyBytes !== null) {
    body = prepared.bodyBytes;
  }

  const init: RequestInit = {
    headers,
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
  };
  const deadline = withDeadline(prepared.request.signal, runtime.paymentRetryMs);
  if (deadline.signal !== undefined) init.signal = deadline.signal;
  if (body instanceof ReadableStream) {
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  return { request: new Request(prepared.request, init), deadline };
}

/**
 * Everything between a parsed challenge and a delivered resource.
 *
 * Exactly one signature is created and exactly one signature-bearing request is sent
 * (ADR-003). The re-challenge loop of SPEC §6.7 — a fresh challenge, a fresh nonce, and
 * `maxPaidAttempts` — lands with M6; a merchant that answers the paid retry with another 402
 * is reported here rather than retried.
 */
async function executePayment(
  runtime: ClientRuntime,
  prepared: PreparedRequest,
  inspection: PaymentInspection & { paymentRequired: NormalizedPaymentRequired },
  startedAt: number,
  /** Receives the selected asset so the budget snapshot can be refreshed either way. */
  selection: { assetId?: string },
): Promise<Response> {
  const { requestId } = inspection;
  const challenge = inspection.paymentRequired;

  /* Policy — entirely local, before any balance read or signer call (SEC-002). */
  const decision = await runtime.policyEngine.evaluate(challenge, {
    requestId,
    policyScope: runtime.policyScope,
    nowEpochMs: runtime.clock.now(),
    spendStore: runtime.spendStore,
  });
  emit(runtime.logger, "info", {
    event: "policy.checked",
    requestId,
    outcome: "allowed",
    policyCode: "allowed",
  });

  /* Route planning — balances may be queried only now (SPEC §6.3 step 13). */
  const selected = await planRoutes(
    runtime,
    decision.requirements,
    requestId,
    runtime.clock.now(),
  );
  selection.assetId = selected.requirement.assetId;
  emit(runtime.logger, "info", {
    event: "route.planned",
    requestId,
    candidateCount: decision.requirements.length,
    selectedNetwork: selected.route.networkId,
    selectedScheme: selected.route.scheme,
  });

  /* Reservation — atomic, and strictly before the signer exists in this scope. */
  const requestHash = fingerprintRequest({
    method: prepared.method,
    url: prepared.url,
    body: prepared.bodyBytes,
    challengeHash: challenge.headerHash,
  });
  const reservation: SpendReservation = await runtime.spendStore.reserve({
    requestId,
    policyScope: runtime.policyScope,
    requestFingerprint: requestHash,
    assetId: selected.requirement.assetId,
    amountAtomic: selected.requirement.amountAtomic,
    maxPerHourAtomic: selected.requirement.maxPerHourAtomic,
    nowEpochMs: runtime.clock.now(),
  });
  emit(runtime.logger, "info", {
    event: "budget.reserved",
    requestId,
    reservationId: reservation.reservationId,
    assetId: reservation.assetId,
    amountAtomic: reservation.amountAtomic,
  });

  const errorContext: Tx402ErrorContext = {
    requestId,
    phase: "sign",
    network: selected.route.networkId,
    scheme: selected.route.scheme,
    amountAtomic: selected.requirement.amountAtomic,
    assetId: selected.requirement.assetId,
    reservationId: reservation.reservationId,
  };

  /* Signing. Any failure here is pre-transmission: release and report. */
  let signatureHeader: string;
  const signStartedAt = runtime.clock.monotonic();
  try {
    emit(runtime.logger, "debug", {
      event: "sign.started",
      requestId,
      signerKind: chainFamily(selected.route.networkId) === "eip155" ? "evm" : "solana",
    });
    const network = runtime.manifest.networks[selected.route.networkId];
    if (network === undefined) {
      throw new ConfigurationError("Selected network vanished from the manifest", {
        context: errorContext,
        details: { configPath: "manifest.networks", reason: "unknown-network" },
      });
    }
    const authorization = await selected.adapter.createAuthorization({
      requestId,
      networkId: selected.route.networkId,
      network,
      asset: selected.requirement.manifestAsset,
      requirement: selected.requirement,
      signer: signerFor(runtime.signers, chainFamily(selected.route.networkId)),
      nowEpochMs: runtime.clock.now(),
      resourceHost: normalizePolicyHost(prepared.url),
      requestHash,
      maxAuthorizationSeconds: MAX_AUTHORIZATION_SECONDS,
    });
    signatureHeader = encodePaymentSignatureHeader({
      x402Version: authorization.x402Version,
      accepted: {
        scheme: selected.requirement.scheme,
        network: selected.requirement.network as `${string}:${string}`,
        asset: selected.requirement.asset,
        amount: selected.requirement.amountAtomic,
        payTo: selected.requirement.payTo,
        maxTimeoutSeconds: selected.requirement.maxTimeoutSeconds,
        extra: { ...selected.requirement.extra },
      },
      payload: { ...authorization.payload },
      ...(authorization.extensions === undefined
        ? {}
        : { extensions: { ...authorization.extensions } }),
    });
    emit(runtime.logger, "debug", {
      event: "sign.completed",
      requestId,
      signerKind: "evm",
      durationMs: Math.max(0, runtime.clock.monotonic() - signStartedAt),
    });
  } catch (error) {
    await releaseQuietly(runtime, reservation.reservationId);
    throw error;
  }

  /* One signature, one attempt (ADR-003). */
  let paid: { request: Request; deadline: Deadline };
  try {
    paid = await buildPaidRequest(prepared, signatureHeader, requestId, runtime);
  } catch (error) {
    await releaseQuietly(runtime, reservation.reservationId);
    throw error;
  }

  emit(runtime.logger, "info", {
    event: "request.retried",
    requestId,
    attempt: 1,
    selectedNetwork: selected.route.networkId,
  });

  let response: Response;
  try {
    response = await issuePaidRetry(
      paid.request,
      requestId,
      globalThis.fetch,
      paid.deadline,
    );
  } catch (error) {
    if (error instanceof PaidRedirectBlockedError) {
      // The signature reached the merchant; only the follow-up was blocked. Whether the
      // merchant settled is unknown, so the reservation stays (SPEC §6.7).
      throw ambiguous(runtime, error, reservation, errorContext, "redirect-blocked");
    }
    throw ambiguous(runtime, error, reservation, errorContext, "transport-after-signature");
  } finally {
    // Held until the attempt settles, then released — the timer must outlive the request and
    // must not outlive it by longer than necessary.
    paid.deadline.dispose();
  }

  if (response.status === 402) {
    // A fresh challenge is definitive: the merchant did not accept the payment, so no
    // settlement evidence exists and the reservation is released. Re-signing against the new
    // challenge is M6's `maxPaidAttempts` loop.
    await releaseQuietly(runtime, reservation.reservationId);
    throw new ResourceDeliveryError("Merchant re-challenged the paid request", {
      context: { ...errorContext, phase: "retry", paid: false },
      details: { status: 402, reason: "rechallenged" },
    });
  }

  if (!response.ok) {
    if (response.status >= 500) {
      throw ambiguous(runtime, undefined, reservation, errorContext, "server-error");
    }
    // A 4xx is the merchant refusing the request outright: no settlement, so release.
    await releaseQuietly(runtime, reservation.reservationId);
    throw new ResourceDeliveryError("Merchant rejected the paid request", {
      context: { ...errorContext, phase: "retry", paid: false },
      details: { status: response.status, reason: "paid-request-rejected" },
    });
  }

  const settlement = readPaymentResponse(response, requestId, runtime.logger);
  if (settlement !== undefined && !settlement.success) {
    await releaseQuietly(runtime, reservation.reservationId);
    throw new ResourceDeliveryError("Merchant reported an unsuccessful settlement", {
      context: { ...errorContext, phase: "complete", paid: false },
      details: { status: response.status, reason: "settlement-unsuccessful" },
    });
  }

  const entry = await runtime.spendStore.commit({
    reservationId: reservation.reservationId,
    committedAtEpochMs: runtime.clock.now(),
    ...(settlement?.settlementId === undefined
      ? {}
      : { settlementId: settlement.settlementId }),
  });

  emit(runtime.logger, "info", {
    event: "payment.completed",
    requestId,
    paid: true,
    ...(entry.settlementId === undefined
      ? {}
      : { settlementIdHash: settlementIdHash(entry.settlementId) }),
    totalSdkOverheadMs: Math.max(0, runtime.clock.monotonic() - startedAt),
  });
  return response;
}

/** Releases a reservation without letting a store failure mask the original error. */
async function releaseQuietly(
  runtime: ClientRuntime,
  reservationId: string,
): Promise<void> {
  try {
    await runtime.spendStore.release(reservationId, runtime.clock.now());
  } catch {
    // The reservation expires on its own after 120 s; a store that cannot release is not a
    // reason to replace a precise failure with a vaguer one.
  }
}

function ambiguous(
  runtime: ClientRuntime,
  cause: unknown,
  reservation: SpendReservation,
  errorContext: Tx402ErrorContext,
  causeCategory: string,
): AmbiguousPaymentError {
  emit(runtime.logger, "warn", {
    event: "request.failed",
    requestId: errorContext.requestId,
    errorCode: "TX402_PAYMENT_AMBIGUOUS",
    phase: "retry",
    paid: "unknown",
  });
  return new AmbiguousPaymentError(
    "The payment was transmitted but its outcome is unknown",
    {
      context: { ...errorContext, phase: "retry", paid: "unknown" },
      details: {
        reservationExpiresAtEpochMs: reservation.expiresAtEpochMs,
        causeCategory,
      },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/* ------------------------------------------------------------------------------------- */
/* Construction                                                                            */
/* ------------------------------------------------------------------------------------- */

function validateTimeouts(timeouts: Tx402Timeouts | undefined): number {
  const initial = timeouts?.initialRequestMs;
  if (initial !== undefined && (!Number.isInteger(initial) || initial < 1)) {
    throw new ConfigurationError("timeouts.initialRequestMs must be a positive integer", {
      context: context("configuration", "initial"),
      details: {
        configPath: "timeouts.initialRequestMs",
        reason: "expected-positive-integer",
      },
    });
  }
  const retry = timeouts?.paymentRetryMs ?? DEFAULT_PAYMENT_RETRY_MS;
  if (!Number.isInteger(retry) || retry < MIN_PAYMENT_RETRY_MS) {
    throw new ConfigurationError(
      `timeouts.paymentRetryMs must be an integer of at least ${MIN_PAYMENT_RETRY_MS}`,
      {
        context: context("configuration", "initial"),
        details: { configPath: "timeouts.paymentRetryMs", reason: "below-minimum" },
      },
    );
  }
  return retry;
}

/** Construct an immutable client and validate configuration synchronously (SPEC §4.1). */
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
  const paymentRetryMs = validateTimeouts(config.timeouts);
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

  const runtime: ClientRuntime = {
    manifest,
    policyEngine,
    spendStore,
    policyScope: uuidV7(clock.now()),
    clock,
    logger,
    signers: config.signers ?? {},
    adapters: new Map(),
    paymentRetryMs,
    disableRequestIdHeader: config.disableRequestIdHeader ?? false,
  };

  let budgetState: BudgetState = Object.freeze({
    storeKind: spendStore.kind,
    committedAtomic: "0",
    reservedAtomic: "0",
    entries: Object.freeze([]),
    reservations: Object.freeze([]),
  });

  const refreshBudgetState = async (assetId: string): Promise<void> => {
    try {
      budgetState = await spendStore.getBudgetState({
        policyScope: runtime.policyScope,
        assetId,
        nowEpochMs: clock.now(),
      });
    } catch {
      // A snapshot is diagnostics. Failing to refresh it must not fail a paid request.
    }
  };

  const begin = async (
    input: Tx402RequestInfo,
    init: Tx402RequestInit | undefined,
    requestId: string,
  ): Promise<{ prepared: PreparedRequest; response: Response }> => {
    const prepared = await prepareRequest(input, init, allowInsecureLocalhost, requestId);
    policyEngine.assertDomain(prepared.url, requestId, "initial");
    emit(logger, "info", {
      event: "request.started",
      requestId,
      method: prepared.method,
      normalizedHost: normalizePolicyHost(prepared.url),
    });
    const response = await issueInitial(
      prepared.request,
      requestId,
      config.timeouts?.initialRequestMs,
    );
    return { prepared, response };
  };

  const failure = (
    error: unknown,
    requestId: string,
    phase: Tx402ErrorContext["phase"],
  ) => {
    const typed = isTx402Error(error)
      ? error
      : new TransportError("Request failed", {
          context: context(requestId, phase),
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
    return typed;
  };

  const inspect = async (
    input: Tx402RequestInfo,
    init?: Tx402RequestInit,
  ): Promise<PaymentInspection> => {
    const started = clock.monotonic();
    const requestId = uuidV7(clock.now());
    let phase: Tx402ErrorContext["phase"] = "initial";
    try {
      const { prepared, response } = await begin(input, init, requestId);
      if (response.status !== 402) return Object.freeze({ requestId, response });

      phase = "parse";
      const paymentRequired = decodePaymentRequired(
        response.headers.get(PROTOCOL_HEADERS.paymentRequired),
        {
          requestUrl: prepared.url,
          requestMethod: prepared.method,
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
      throw failure(error, requestId, phase);
    }
  };

  const client: Tx402Client = {
    inspect,
    async fetch(input, init) {
      const started = clock.monotonic();
      const requestId = uuidV7(clock.now());
      let phase: Tx402ErrorContext["phase"] = "initial";
      try {
        const { prepared, response } = await begin(input, init, requestId);
        if (response.status !== 402) return response;

        phase = "parse";
        const paymentRequired = decodePaymentRequired(
          response.headers.get(PROTOCOL_HEADERS.paymentRequired),
          {
            requestUrl: prepared.url,
            requestMethod: prepared.method,
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
        });

        phase = "policy";
        const selection: { assetId?: string } = {};
        try {
          return await executePayment(
            runtime,
            prepared,
            { requestId, response, paymentRequired },
            started,
            selection,
          );
        } finally {
          if (selection.assetId !== undefined) await refreshBudgetState(selection.assetId);
        }
      } catch (error) {
        throw failure(error, requestId, phase);
      }
    },
    getBudgetState: () => budgetState,
    resetHealth: () => {
      for (const pending of runtime.adapters.values()) {
        void pending.then(
          (adapter) => adapter?.resetHealth(),
          () => undefined,
        );
      }
    },
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
