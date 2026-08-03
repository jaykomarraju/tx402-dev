/** Minimal Solana JSON-RPC pool for cluster identity and canonical SPL ATA balances. */

import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { address } from "@solana/kit";

import { CIRCUIT_OPEN_MS, MAX_PROVIDERS_PER_NETWORK } from "../core/chain.js";

export type SvmRpcFailure =
  | "circuit-open"
  | "genesis-hash-mismatch"
  | "genesis-hash-unreadable"
  | "account-unreadable"
  | "transport"
  | "timeout"
  | "protocol";

export class SvmRpcError extends Error {
  constructor(
    readonly failure: SvmRpcFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SvmRpcError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface Endpoint {
  readonly url: string;
  readonly label: string;
  openUntilEpochMs: number;
}

export interface SvmRpcPoolOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly maxProviders?: number;
}

export interface SvmBalanceReading {
  readonly balanceAtomic: bigint;
  readonly tokenAccount: string;
  readonly endpoint: string;
  /** Exact endpoint URL. Sensitive only inside the adapter; never placed in diagnostics. */
  readonly rpcUrl: string;
}

interface JsonRpcEnvelope {
  readonly result?: unknown;
  readonly error?: unknown;
}

const UINT_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

function safeLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-rpc-url";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Races the RPC in tx402's own control flow. The abort signal is only socket cleanup; it is
 * not trusted to enforce the deadline (S5's Request/WeakRef failure).
 */
async function raceRpcDeadline<T>(
  work: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  let rejectDeadline!: (reason: Error) => void;
  const expired = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  expired.catch(() => undefined);
  const timer = setTimeout(() => {
    const error = new Error(`Solana RPC deadline of ${timeoutMs} ms exceeded`);
    error.name = "TimeoutError";
    controller.abort(error);
    rejectDeadline(error);
  }, timeoutMs);
  timer.unref();
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export class SvmRpcPool {
  readonly #endpoints: Endpoint[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  #requestId = 0;

  constructor(rpcUrls: readonly string[], options: SvmRpcPoolOptions = {}) {
    this.#endpoints = rpcUrls
      .slice(0, options.maxProviders ?? MAX_PROVIDERS_PER_NETWORK)
      .map((url) => ({ url, label: safeLabel(url), openUntilEpochMs: 0 }));
    this.#timeoutMs = options.timeoutMs ?? 600;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  resetHealth(): void {
    for (const endpoint of this.#endpoints) endpoint.openUntilEpochMs = 0;
  }

  async readBalance(input: {
    readonly genesisHash: string;
    readonly mint: string;
    readonly owner: string;
    readonly decimals: number;
    readonly nowEpochMs: number;
  }): Promise<SvmBalanceReading> {
    const [tokenAccount] = await findAssociatedTokenPda({
      mint: address(input.mint),
      owner: address(input.owner),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const attempted = new Set<string>();
    let last = new SvmRpcError("transport", "No Solana RPC returned an ATA balance");
    while (attempted.size < this.#endpoints.length) {
      const endpoint = await this.#withValidatedEndpoint(
        input.genesisHash,
        input.nowEpochMs,
        attempted,
      );
      try {
        const result = await this.#call(endpoint, "getAccountInfo", [
          tokenAccount,
          { encoding: "jsonParsed", commitment: "confirmed" },
        ]);
        const balanceAtomic = parseTokenAccount(
          result,
          input.owner,
          input.mint,
          input.decimals,
        );
        return {
          balanceAtomic,
          tokenAccount: tokenAccount.toString(),
          endpoint: endpoint.label,
          rpcUrl: endpoint.url,
        };
      } catch (error) {
        this.#open(endpoint, input.nowEpochMs);
        last =
          error instanceof SvmRpcError
            ? error
            : new SvmRpcError("account-unreadable", "SPL token account is unreadable", {
                cause: error,
              });
      }
    }
    throw last;
  }

  /** Selects an endpoint only after it proves its genesis hash immediately before signing. */
  async validatedRpcUrl(
    genesisHash: string,
    nowEpochMs: number,
  ): Promise<{ readonly url: string; readonly endpoint: string }> {
    const endpoint = await this.#withValidatedEndpoint(genesisHash, nowEpochMs);
    return { url: endpoint.url, endpoint: endpoint.label };
  }

  async #withValidatedEndpoint(
    expectedGenesisHash: string,
    nowEpochMs: number,
    attempted: Set<string> = new Set(),
  ): Promise<Endpoint> {
    if (this.#endpoints.length === 0) {
      throw new SvmRpcError("transport", "No RPC endpoint is configured for this cluster");
    }
    const available = this.#endpoints.filter((endpoint) => !attempted.has(endpoint.url));
    const closed = available.filter((endpoint) => endpoint.openUntilEpochMs <= nowEpochMs);
    const order = closed.length > 0 ? closed : available;
    let last = new SvmRpcError("circuit-open", "Every Solana RPC endpoint is open");
    for (const endpoint of order) {
      attempted.add(endpoint.url);
      try {
        const observed = await this.#call(endpoint, "getGenesisHash", []);
        if (typeof observed !== "string" || observed.length === 0) {
          throw new SvmRpcError(
            "genesis-hash-unreadable",
            "RPC returned a malformed genesis hash",
          );
        }
        if (observed !== expectedGenesisHash) {
          this.#open(endpoint, nowEpochMs);
          last = new SvmRpcError(
            "genesis-hash-mismatch",
            "RPC serves a different Solana cluster",
          );
          continue;
        }
        return endpoint;
      } catch (error) {
        this.#open(endpoint, nowEpochMs);
        last =
          error instanceof SvmRpcError
            ? error
            : new SvmRpcError("transport", "Solana RPC call failed", { cause: error });
      }
    }
    throw last;
  }

  #open(endpoint: Endpoint, nowEpochMs: number): void {
    endpoint.openUntilEpochMs = nowEpochMs + CIRCUIT_OPEN_MS;
  }

  async #call(endpoint: Endpoint, method: string, params: unknown[]): Promise<unknown> {
    this.#requestId += 1;
    const controller = new AbortController();
    let response: Response;
    try {
      response = await raceRpcDeadline(
        this.#fetch(endpoint.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: this.#requestId,
            method,
            params,
          }),
          signal: controller.signal,
        }),
        controller,
        this.#timeoutMs,
      );
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new SvmRpcError(timedOut ? "timeout" : "transport", `${method} failed`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new SvmRpcError("transport", `${method} returned HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new SvmRpcError("protocol", `${method} returned non-JSON`, { cause: error });
    }
    if (!isRecord(body)) {
      throw new SvmRpcError("protocol", `${method} returned a non-object envelope`);
    }
    const envelope = body as JsonRpcEnvelope;
    if (envelope.error !== undefined || !("result" in envelope)) {
      throw new SvmRpcError("protocol", `${method} returned a JSON-RPC error`);
    }
    return envelope.result;
  }
}

function parseTokenAccount(
  result: unknown,
  expectedOwner: string,
  expectedMint: string,
  expectedDecimals: number,
): bigint {
  if (!isRecord(result) || !("value" in result)) {
    throw new SvmRpcError("account-unreadable", "getAccountInfo returned no value member");
  }
  if (result.value === null) return 0n;
  const value = result.value;
  if (!isRecord(value) || value.owner !== TOKEN_PROGRAM_ADDRESS.toString()) {
    throw new SvmRpcError("account-unreadable", "ATA is not owned by SPL Token");
  }
  const data = value.data;
  const parsed = isRecord(data) ? data.parsed : undefined;
  const info = isRecord(parsed) ? parsed.info : undefined;
  const tokenAmount = isRecord(info) ? info.tokenAmount : undefined;
  if (
    !isRecord(info) ||
    info.owner !== expectedOwner ||
    info.mint !== expectedMint ||
    !isRecord(tokenAmount) ||
    tokenAmount.decimals !== expectedDecimals ||
    typeof tokenAmount.amount !== "string" ||
    !UINT_PATTERN.test(tokenAmount.amount)
  ) {
    throw new SvmRpcError("account-unreadable", "ATA contents do not match the route");
  }
  return BigInt(tokenAmount.amount);
}
