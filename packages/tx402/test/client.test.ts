import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTx402Client,
  issuePaidRetry,
  paymentRequiredReason,
  type Tx402Logger,
} from "../src/core/client.js";
import {
  InvalidPaymentRequiredError,
  NonReplayableRequestError,
  PaidRedirectBlockedError,
  ReservedHeaderError,
  TransportError,
} from "../src/core/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function challenge(scheme = "exact", network = "eip155:8453"): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: "https://api.example.com/resource" },
    accepts: [
      {
        scheme,
        network: network as `${string}:${string}`,
        asset: "asset",
        amount: "1",
        payTo: "recipient",
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  });
}

describe("M1 client transport", () => {
  it("T-001 returns a non-402 Response unchanged", async () => {
    const response = new Response("free", {
      status: 200,
      headers: { "x-origin": "merchant" },
    });
    const transport = vi.fn(() => Promise.resolve(response));
    vi.stubGlobal("fetch", transport);
    const client = createTx402Client();

    const actual = await client.fetch("https://api.example.com/resource");

    expect(actual).toBe(response);
    expect(await actual.text()).toBe("free");
    expect(transport).toHaveBeenCalledOnce();
    expect(client.getBudgetState()).toEqual({
      storeKind: "memory",
      committedAtomic: "0",
      reservedAtomic: "0",
      entries: [],
      reservations: [],
    });
    expect(() => client.resetHealth()).not.toThrow();
  });

  it("inspect returns the normalized first challenge without signing or retrying", async () => {
    const transport = vi.fn(() =>
      Promise.resolve(
        new Response("payment required", {
          status: 402,
          headers: { "payment-required": challenge() },
        }),
      ),
    );
    vi.stubGlobal("fetch", transport);

    const inspection = await createTx402Client().inspect(
      "https://api.example.com/resource",
      { method: "post", body: "hello" },
    );

    expect(inspection.paymentRequired?.resource.method).toBe("POST");
    expect(inspection.paymentRequired?.requirements[0]?.amountAtomic).toBe("1");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("T-009 raises a typed invalid error for a malformed challenge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(null, { status: 402, headers: { "payment-required": "!!!" } }),
        ),
      ),
    );
    await expect(
      createTx402Client().fetch("https://api.example.com/resource"),
    ).rejects.toMatchObject({
      code: "TX402_PAYMENT_REQUIRED_INVALID",
      details: { reason: "invalid-base64", schemaPath: "/" },
    });
  });

  it("T-013 rejects a stream before the initial request unless bodyFactory is provided", async () => {
    const transport = vi.fn((_request: Request) => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", transport);
    const client = createTx402Client();
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    await expect(
      client.fetch("https://api.example.com/resource", { method: "POST", body: stream }),
    ).rejects.toBeInstanceOf(NonReplayableRequestError);
    expect(transport).not.toHaveBeenCalled();

    let observed = "";
    transport.mockImplementation(async (request: Request) => {
      observed = await request.text();
      return new Response("ok");
    });
    await client.fetch("https://api.example.com/resource", {
      method: "POST",
      bodyFactory: () => "fresh body",
    });
    expect(observed).toBe("fresh body");
  });

  it("T-018 reports unknown schemes and networks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(null, {
            status: 402,
            headers: { "payment-required": challenge("mystery", "eip155:999999") },
          }),
        ),
      ),
    );
    await expect(
      createTx402Client().fetch("https://api.example.com/resource"),
    ).rejects.toMatchObject({
      code: "TX402_SCHEME_UNSUPPORTED",
      details: { offeredSchemes: ["mystery"], offeredNetworks: ["eip155:999999"] },
    });
  });

  it("rejects caller-supplied protocol headers and public HTTP", async () => {
    const client = createTx402Client();
    await expect(
      client.fetch("https://api.example.com/resource", {
        headers: { "payment-signature": "secret" },
      }),
    ).rejects.toBeInstanceOf(ReservedHeaderError);
    await expect(client.fetch("http://example.com/resource")).rejects.toMatchObject({
      code: "TX402_CONFIG_INVALID",
      details: { reason: "https-required" },
    });
  });

  it("permits explicit insecure localhost mode only for loopback hosts", async () => {
    const transport = vi.fn(() => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", transport);
    await createTx402Client({ allowInsecureLocalhost: true }).fetch(
      "http://127.0.0.1:4321/",
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it("emits only redaction-safe diagnostics", async () => {
    const events: Record<string, unknown>[] = [];
    const record = (event: Readonly<Record<string, unknown>>) => events.push({ ...event });
    const logger: Tx402Logger = {
      debug: record,
      info: record,
      warn: record,
      error: record,
    };
    const secret = "Bearer seeded-super-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("ok"))),
    );

    await createTx402Client({ logger }).fetch("https://api.example.com/resource", {
      method: "POST",
      headers: { authorization: secret, cookie: "session=seeded-cookie" },
      body: "seeded-request-body",
    });

    expect(events.map((event) => event.event)).toEqual(["request.started"]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("seeded-cookie");
    expect(JSON.stringify(events)).not.toContain("seeded-request-body");
  });

  it("blocks a cross-origin paid redirect before any follow-up transmission", async () => {
    const transport = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.example/paid" },
        }),
      ),
    );
    const request = new Request("https://api.example.com/resource", {
      headers: { "payment-signature": "sensitive" },
    });
    await expect(issuePaidRetry(request, "retry-test", transport)).rejects.toBeInstanceOf(
      PaidRedirectBlockedError,
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it("returns a validated supported 402 at the M1 milestone boundary", async () => {
    const response = new Response(null, {
      status: 402,
      headers: { "payment-required": challenge() },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response)),
    );
    expect(await createTx402Client().fetch("https://api.example.com/resource")).toBe(
      response,
    );
  });

  it("isolates logger failures and validates the localhost flag synchronously", async () => {
    const throwing = () => {
      throw new Error("logger unavailable");
    };
    const logger: Tx402Logger = {
      debug: throwing,
      info: throwing,
      warn: throwing,
      error: throwing,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("ok"))),
    );
    await expect(
      createTx402Client({ logger }).fetch(new Request("https://api.example.com/resource")),
    ).resolves.toHaveProperty("status", 200);
    expect(() =>
      createTx402Client({ allowInsecureLocalhost: "yes" as unknown as boolean }),
    ).toThrowError(/allowInsecureLocalhost/u);
  });

  it("classifies initial and paid-retry network failures as TransportError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("seeded network detail"))),
    );
    await expect(
      createTx402Client().fetch("https://api.example.com/resource"),
    ).rejects.toBeInstanceOf(TransportError);

    const retry = vi.fn(() => Promise.reject(new Error("seeded retry detail")));
    await expect(
      issuePaidRetry(new Request("https://api.example.com/resource"), "retry", retry),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("accepts same-origin and non-redirect paid-retry responses", async () => {
    const sameOrigin = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 307, headers: { location: "/next" } })),
    );
    await expect(
      issuePaidRetry(new Request("https://api.example.com/resource"), "retry", sameOrigin),
    ).resolves.toHaveProperty("status", 307);

    const delivered = vi.fn(() => Promise.resolve(new Response("ok", { status: 200 })));
    await expect(
      issuePaidRetry(new Request("https://api.example.com/resource"), "retry", delivered),
    ).resolves.toHaveProperty("status", 200);
  });

  it("types bodyFactory failures and supports a stream produced by the factory", async () => {
    const client = createTx402Client();
    await expect(
      client.fetch("https://api.example.com/resource", {
        method: "POST",
        bodyFactory: () => {
          throw new Error("seeded factory detail");
        },
      }),
    ).rejects.toMatchObject({
      code: "TX402_NON_REPLAYABLE",
      details: { reason: "body-factory-failed" },
    });

    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        body = await request.text();
        return new Response("ok");
      }),
    );
    await client.fetch("https://api.example.com/resource", {
      method: "POST",
      bodyFactory: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("streamed"));
            controller.close();
          },
        }),
    });
    expect(body).toBe("streamed");
  });

  it("extracts only a typed invalid-payment reason", () => {
    const error = new InvalidPaymentRequiredError("invalid", {
      context: { requestId: "id", phase: "parse" },
      details: { reason: "invalid-json", schemaPath: "/" },
    });
    expect(paymentRequiredReason(error)).toBe("invalid-json");
    expect(paymentRequiredReason(new Error("invalid-json"))).toBeUndefined();
  });
});
