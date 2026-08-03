/**
 * Minimal JSON-RPC access for the Base adapter (SPEC §7.1).
 *
 * Two methods, and no more: `eth_chainId` and an `eth_call` of ERC-20 `balanceOf`. SPEC §7.1
 * limits the buyer's RPC surface to chain identity, token balance, and metadata the upstream
 * scheme requires; the exact scheme needs no nonce or fee data, so nothing else is reachable
 * from here. The buyer never broadcasts.
 *
 * **Why not viem.** viem would supply both calls, but tx402 needs per-endpoint deadlines,
 * per-endpoint circuit state, and a failover order it controls, and it needs all three to
 * behave identically in Python at S9. Two JSON-RPC calls over `fetch` are less code than the
 * adapter that would wrap viem's client to get the same control, and they leave the chain
 * library used for exactly one thing — signing.
 *
 * **Chain identity is verified on every use, not cached.** SPEC §7.1 requires the RPC's chain
 * ID to equal the candidate's CAIP-2 chain ID before signing, and the threat model (SPEC
 * §9.1, "RPC chain spoofing") is a provider that answers for the wrong chain. A cached
 * verification would be a verification of a previous answer, so each balance read re-verifies
 * on the same endpoint that serves it.
 */

import { CIRCUIT_OPEN_MS, MAX_PROVIDERS_PER_NETWORK } from "../core/chain.js";
import { encodeBalanceOfCallData } from "./plan.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u;

/** Why an endpoint failed. Stable labels; never a provider's own message (SEC-003). */
export type EvmRpcFailure =
  | "circuit-open"
  | "chain-id-mismatch"
  | "chain-id-unreadable"
  | "balance-unreadable"
  | "transport"
  | "timeout"
  | "protocol";

export class EvmRpcError extends Error {
  constructor(
    readonly failure: EvmRpcFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "EvmRpcError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface Endpoint {
  readonly url: string;
  /** Host only. The full URL may embed an API key, which is a secret (SEC-003). */
  readonly label: string;
  openUntilEpochMs: number;
  consecutiveFailures: number;
}

export interface EvmRpcPoolOptions {
  /** Per-provider deadline. Defaults to the SPEC §6.4 budget of 600 ms. */
  readonly timeoutMs?: number;
  /** Injected for tests; production always uses the platform `fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly maxProviders?: number;
}

/** The outcome of a balance read, together with which endpoint answered. */
export interface EvmBalanceReading {
  readonly balanceAtomic: bigint;
  readonly chainId: number;
  readonly endpoint: string;
}

function hexToBigInt(value: string): bigint {
  if (!/^0x[0-9a-fA-F]{1,64}$/u.test(value)) {
    throw new EvmRpcError("protocol", "RPC returned a malformed quantity");
  }
  return BigInt(value);
}

/**
 * An ordered set of RPC endpoints for one network, with per-endpoint circuit state.
 *
 * The circuit here is deliberately the smaller half of SPEC §6.5 — open on failure, 30 s,
 * one probe on the far side. The EWMA scoring, the 20-observation window, and the 128-entry
 * LRU belong to the HealthIndex at M5, which will subsume this. What cannot wait for M5 is
 * SPEC §7.1's rule that a chain-ID mismatch opens the endpoint and moves to the next RPC:
 * that is a security boundary, not a performance heuristic.
 */
export class EvmRpcPool {
  readonly #endpoints: Endpoint[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  #requestId = 0;

  constructor(rpcUrls: readonly string[], options: EvmRpcPoolOptions = {}) {
    const limit = options.maxProviders ?? MAX_PROVIDERS_PER_NETWORK;
    this.#endpoints = rpcUrls.slice(0, limit).map((url) => ({
      url,
      label: safeLabel(url),
      openUntilEpochMs: 0,
      consecutiveFailures: 0,
    }));
    this.#timeoutMs = options.timeoutMs ?? 600;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  get endpointLabels(): readonly string[] {
    return this.#endpoints.map((endpoint) => endpoint.label);
  }

  resetHealth(): void {
    for (const endpoint of this.#endpoints) {
      endpoint.openUntilEpochMs = 0;
      endpoint.consecutiveFailures = 0;
    }
  }

  /**
   * Reads a token balance from an endpoint that has just proved it serves `chainId`.
   *
   * Endpoints are tried in manifest order, closed circuits first. An open circuit is used
   * only when every endpoint is open (SPEC §6.5) — and even then the chain-ID check runs
   * again, so an endpoint that was opened for lying about its chain cannot slip through on
   * the last-resort pass.
   */
  async readBalance(input: {
    readonly chainId: number;
    readonly token: string;
    readonly owner: string;
    readonly nowEpochMs: number;
  }): Promise<EvmBalanceReading> {
    if (!ADDRESS_PATTERN.test(input.token) || !ADDRESS_PATTERN.test(input.owner)) {
      throw new EvmRpcError("protocol", "Token and owner must be 20-byte hex addresses");
    }
    if (this.#endpoints.length === 0) {
      throw new EvmRpcError("transport", "No RPC endpoint is configured for this network");
    }

    const closed = this.#endpoints.filter(
      (endpoint) => endpoint.openUntilEpochMs <= input.nowEpochMs,
    );
    const order = closed.length > 0 ? closed : this.#endpoints;

    let last: EvmRpcError = new EvmRpcError("circuit-open", "Every RPC endpoint is open");
    for (const endpoint of order) {
      try {
        const observed = await this.#chainId(endpoint);
        if (observed !== input.chainId) {
          // SPEC §7.1: a mismatch is not a slow endpoint, it is the wrong chain. Open it
          // and move on rather than reading a balance that would describe another network.
          this.#open(endpoint, input.nowEpochMs);
          last = new EvmRpcError(
            "chain-id-mismatch",
            `RPC reported chain ${observed}, expected ${input.chainId}`,
          );
          continue;
        }
        const raw = await this.#call<string>(endpoint, "eth_call", [
          { to: input.token, data: encodeBalanceOfCallData(input.owner) },
          "latest",
        ]);
        if (typeof raw !== "string") {
          throw new EvmRpcError("balance-unreadable", "RPC returned a non-string balance");
        }
        endpoint.consecutiveFailures = 0;
        return {
          balanceAtomic: hexToBigInt(raw === "0x" ? "0x0" : raw),
          chainId: observed,
          endpoint: endpoint.label,
        };
      } catch (error) {
        this.#open(endpoint, input.nowEpochMs);
        last =
          error instanceof EvmRpcError
            ? error
            : new EvmRpcError("transport", "RPC call failed", { cause: error });
      }
    }
    throw last;
  }

  #open(endpoint: Endpoint, nowEpochMs: number): void {
    endpoint.consecutiveFailures += 1;
    endpoint.openUntilEpochMs = nowEpochMs + CIRCUIT_OPEN_MS;
  }

  async #chainId(endpoint: Endpoint): Promise<number> {
    const raw = await this.#call<string>(endpoint, "eth_chainId", []);
    if (typeof raw !== "string" || !QUANTITY_PATTERN.test(raw)) {
      throw new EvmRpcError("chain-id-unreadable", "RPC returned a malformed chain ID");
    }
    const chainId = Number(BigInt(raw));
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new EvmRpcError("chain-id-unreadable", "RPC returned an out-of-range chain ID");
    }
    return chainId;
  }

  async #call<T>(endpoint: Endpoint, method: string, params: unknown[]): Promise<T> {
    this.#requestId += 1;
    let response: Response;
    try {
      response = await this.#fetch(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.#requestId,
          method,
          params,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new EvmRpcError(timedOut ? "timeout" : "transport", `${method} failed`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new EvmRpcError("transport", `${method} returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new EvmRpcError("protocol", `${method} returned a non-JSON body`, {
        cause: error,
      });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new EvmRpcError("protocol", `${method} returned a non-object body`);
    }
    const envelope = body as { result?: unknown; error?: unknown };
    if (envelope.error !== undefined) {
      // The provider's message may name an API key or an internal host. Drop it.
      throw new EvmRpcError("protocol", `${method} returned a JSON-RPC error`);
    }
    if (!("result" in envelope)) {
      throw new EvmRpcError("protocol", `${method} returned no result`);
    }
    return envelope.result as T;
  }
}

/** Host only: an RPC URL's path or query may carry a provider API key. */
function safeLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-rpc-url";
  }
}
