import httpMocks from "node-mocks-http";
import { ExecutionVersion, envKeys, headerKeys } from "../helpers/consts.ts";
import { signDataWithKey } from "../helpers/net.ts";
import { ConsoleLogger } from "../middleware/logger.ts";
import { serve } from "../next.ts";
import { createClient } from "../test/helpers.ts";
import { internalLoggerSymbol } from "./Inngest.ts";
import { InngestCommHandler, RequestSignature } from "./InngestCommHandler.ts";

/**
 * Helper to run a POST request through a Next.js serve handler and capture
 * the full response including status, body, and headers.
 */
const runHandler = async (
  handler: ReturnType<typeof serve>,
  opts?: {
    body?: Record<string, unknown>;
    env?: Record<string, string>;
    actionOverrides?: Record<string, unknown>;
  },
) => {
  const body = opts?.body ?? {
    ctx: { fn_id: "test-test", run_id: "run-123", step_id: "step" },
    event: { name: "demo/event.sent", data: {} },
    events: [{ name: "demo/event.sent", data: {} }],
    steps: {},
    use_api: false,
  };

  const req = httpMocks.createRequest({
    method: "POST",
    url: "/api/inngest?fnId=test-test&stepId=step",
    headers: {
      host: "localhost:3000",
      "content-type": "application/json",
      "content-length": `${JSON.stringify(body).length}`,
      [headerKeys.InngestRunId]: "run-123",
      [headerKeys.Signature]: "",
    },
    body,
  });
  const res = httpMocks.createResponse();

  const prevEnv = process.env;
  if (opts?.env) {
    process.env = { ...prevEnv, ...opts.env };
  }

  try {
    const args: unknown[] = [req, res];
    if (opts?.actionOverrides) {
      args.push({ actionOverrides: opts.actionOverrides });
    }

    await (handler as (...args: unknown[]) => Promise<unknown>)(...args);

    return {
      status: res.statusCode,
      body: res._getData(),
      headers: res.getHeaders() as Record<string, string>,
    };
  } finally {
    process.env = prevEnv;
  }
};

describe("ServeHandler", () => {
  describe("functions argument", () => {
    test("types: allows mutable functions array", () => {
      const inngest = createClient({ id: "test", isDev: true });

      const functions = [
        inngest.createFunction(
          { id: "test", triggers: [{ event: "demo/event.sent" }] },
          () => "test",
        ),
      ];

      serve({ client: inngest, functions });
    });

    test("types: allows readonly functions array", () => {
      const inngest = createClient({ id: "test", isDev: true });

      const functions = [
        inngest.createFunction(
          { id: "test", triggers: [{ event: "demo/event.sent" }] },
          () => "test",
        ),
      ] as const;

      serve({ client: inngest, functions });
    });
  });

  describe("streaming: force validation", () => {
    const inngest = createClient({ id: "test", isDev: true });

    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );

    test("throws error when streaming is true but handler doesn't support it", async () => {
      const handler = serve({
        client: inngest,
        functions: [fn],
        streaming: true,
      });

      const result = await runHandler(handler, {
        actionOverrides: { transformStreamingResponse: undefined },
      });

      expect(result.status).toBe(500);
      expect(result.body).toMatch(/streaming/i);
    });

    test("throws error when INNGEST_STREAMING=true env var but handler doesn't support it", async () => {
      const handler = serve({
        client: inngest,
        functions: [fn],
      });

      const result = await runHandler(handler, {
        env: { [envKeys.InngestStreaming]: "true" },
        actionOverrides: { transformStreamingResponse: undefined },
      });

      expect(result.status).toBe(500);
      expect(result.body).toMatch(/streaming/i);
    });
  });

  describe("streaming: deprecation warnings", () => {
    afterEach(() => {
      vi.resetModules();
      vi.restoreAllMocks();
    });

    const runHandler = async (
      handler: ReturnType<typeof serve>,
      opts?: {
        env?: Record<string, string>;
      },
    ) => {
      const body = {
        ctx: { fn_id: "test-test", run_id: "run-123", step_id: "step" },
        event: { name: "demo/event.sent", data: {} },
        events: [{ name: "demo/event.sent", data: {} }],
        steps: {},
        use_api: false,
      };

      const req = httpMocks.createRequest({
        method: "POST",
        url: "/api/inngest?fnId=test-test&stepId=step",
        headers: {
          host: "localhost:3000",
          "content-type": "application/json",
          "content-length": `${JSON.stringify(body).length}`,
          [headerKeys.InngestRunId]: "run-123",
          [headerKeys.Signature]: "",
        },
        body,
      });
      const res = httpMocks.createResponse();

      const prevEnv = process.env;
      if (opts?.env) {
        process.env = { ...prevEnv, ...opts.env };
      }

      try {
        await (handler as (...args: unknown[]) => Promise<unknown>)(req, res);
        return { status: res.statusCode, body: res._getData() };
      } finally {
        process.env = prevEnv;
      }
    };

    test("logs deprecation warning when INNGEST_STREAMING=allow", async () => {
      const { serve } = await import("../next.ts");
      const { createClient } = await import("../test/helpers.ts");

      const inngest = createClient({ id: "test", isDev: true });
      const warnSpy = vi.spyOn(inngest[internalLoggerSymbol], "warn");
      const fn = inngest.createFunction(
        { id: "test", triggers: [{ event: "demo/event.sent" }] },
        () => "test",
      );

      const handler = serve({ client: inngest, functions: [fn] });
      await runHandler(handler, {
        env: { [envKeys.InngestStreaming]: "allow" },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ value: "allow" }),
        expect.stringContaining("is deprecated"),
      );
    });

    test("logs deprecation warning when INNGEST_STREAMING=force", async () => {
      const { serve } = await import("../next.ts");
      const { createClient } = await import("../test/helpers.ts");

      const inngest = createClient({ id: "test", isDev: true });
      const warnSpy = vi.spyOn(inngest[internalLoggerSymbol], "warn");
      const fn = inngest.createFunction(
        { id: "test", triggers: [{ event: "demo/event.sent" }] },
        () => "test",
      );

      const handler = serve({ client: inngest, functions: [fn] });
      await runHandler(handler, {
        env: { [envKeys.InngestStreaming]: "force" },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ value: "force" }),
        expect.stringContaining("is deprecated"),
      );
    });

    test("does not log deprecation warning when INNGEST_STREAMING=true", async () => {
      const { serve } = await import("../next.ts");
      const { createClient } = await import("../test/helpers.ts");

      const inngest = createClient({ id: "test", isDev: true });
      const warnSpy = vi.spyOn(inngest[internalLoggerSymbol], "warn");
      const fn = inngest.createFunction(
        { id: "test", triggers: [{ event: "demo/event.sent" }] },
        () => "test",
      );

      const handler = serve({ client: inngest, functions: [fn] });
      await runHandler(handler, {
        env: { [envKeys.InngestStreaming]: "true" },
      });

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("is deprecated"),
      );
    });

    test("does not log deprecation warning when INNGEST_STREAMING is unset", async () => {
      const { serve } = await import("../next.ts");
      const { createClient } = await import("../test/helpers.ts");

      const inngest = createClient({ id: "test", isDev: true });
      const warnSpy = vi.spyOn(inngest[internalLoggerSymbol], "warn");
      const fn = inngest.createFunction(
        { id: "test", triggers: [{ event: "demo/event.sent" }] },
        () => "test",
      );

      const handler = serve({ client: inngest, functions: [fn] });
      await runHandler(handler);

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("is deprecated"),
      );
    });

    test("logs the deprecation warning only once across multiple requests", async () => {
      const { serve } = await import("../next.ts");
      const { createClient } = await import("../test/helpers.ts");

      const inngest = createClient({ id: "test", isDev: true });
      const warnSpy = vi.spyOn(inngest[internalLoggerSymbol], "warn");
      const fn = inngest.createFunction(
        { id: "test", triggers: [{ event: "demo/event.sent" }] },
        () => "test",
      );

      const handler = serve({ client: inngest, functions: [fn] });

      await runHandler(handler, {
        env: { [envKeys.InngestStreaming]: "allow" },
      });
      await runHandler(handler, {
        env: { [envKeys.InngestStreaming]: "allow" },
      });

      const deprecationCalls = warnSpy.mock.calls.filter(
        (args) =>
          typeof args[1] === "string" && args[1].includes("is deprecated"),
      );
      expect(deprecationCalls).toHaveLength(1);
    });
  });
});

describe("error responses", () => {
  test("missing body", async () => {
    const inngest = createClient({ id: "test", isDev: true });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );
    const handler = serve({ client: inngest, functions: [fn] });

    const result = await runHandler(handler, {
      actionOverrides: { body: () => undefined },
    });
    expect(result.status).toBe(401);
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    expect(parsed).toEqual({ message: "Unauthorized" });
  });

  test("missing signature header in cloud mode", async () => {
    const inngest = createClient({
      id: "test",
      isDev: false,
      eventKey: "event-key-123",
      signingKey: "signkey-test-1234567890",
    });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );
    const handler = serve({ client: inngest, functions: [fn] });

    const result = await runHandler(handler, {
      actionOverrides: {
        headers: async (_reason: string, key: string) =>
          key.toLowerCase() === headerKeys.Signature.toLowerCase()
            ? null
            : undefined,
      },
    });
    expect(result.status).toBe(401);
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    expect(parsed).toEqual({ message: "Unauthorized" });
  });

  test("incorrect signature in cloud mode", async () => {
    const inngest = createClient({
      id: "test",
      isDev: false,
      eventKey: "event-key-123",
      signingKey: "signkey-test-1234567890",
    });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );
    const handler = serve({ client: inngest, functions: [fn] });

    // Well-formed but wrong: current timestamp (so it doesn't trip the
    // expiry check) paired with an HMAC that doesn't match the body.
    const ts = Math.round(Date.now() / 1000);
    const badSig = `t=${ts}&s=${"0".repeat(64)}`;

    const result = await runHandler(handler, {
      actionOverrides: {
        headers: async (_reason: string, key: string) =>
          key.toLowerCase() === headerKeys.Signature.toLowerCase()
            ? badSig
            : undefined,
      },
    });
    expect(result.status).toBe(401);
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    expect(parsed).toEqual({ message: "Unauthorized" });
  });
});

describe("response version header", () => {
  const inngest = createClient({ id: "test", isDev: true });

  const fn = inngest.createFunction(
    { id: "test", triggers: [{ event: "demo/event.sent" }] },
    () => "test",
  );

  const handler = serve({ client: inngest, functions: [fn] });

  test("responds with V2 even when request sends V1", async () => {
    const result = await runHandler(handler, {
      body: {
        version: ExecutionVersion.V1,
        ctx: {
          fn_id: "test-test",
          run_id: "run-123",
          step_id: "step",
          attempt: 0,
          disable_immediate_execution: false,
          use_api: false,
          stack: { stack: [], current: 0 },
        },
        event: { name: "demo/event.sent", data: {} },
        events: [{ name: "demo/event.sent", data: {} }],
        steps: {},
      },
    });

    expect(result.status).toBe(206);
    expect(result.headers[headerKeys.RequestVersion]).toBe(
      ExecutionVersion.V2.toString(),
    );
  });

  test("responds with V2 when request sends V2", async () => {
    const result = await runHandler(handler, {
      body: {
        version: ExecutionVersion.V2,
        ctx: {
          fn_id: "test-test",
          run_id: "run-123",
          step_id: "step",
          attempt: 0,
          disable_immediate_execution: false,
          use_api: false,
          stack: { stack: [], current: 0 },
        },
        event: { name: "demo/event.sent", data: {} },
        events: [{ name: "demo/event.sent", data: {} }],
        steps: {},
      },
    });

    expect(result.status).toBe(206);
    expect(result.headers[headerKeys.RequestVersion]).toBe(
      ExecutionVersion.V2.toString(),
    );
  });

  test("responds with V2 when no version in request", async () => {
    const result = await runHandler(handler);

    expect(result.status).toBe(206);
    expect(result.headers[headerKeys.RequestVersion]).toBe(
      ExecutionVersion.V2.toString(),
    );
  });

  test("responds with V1 when function opts out of optimized parallelism", async () => {
    const client = createClient({ id: "test", isDev: true });

    const optedOutFn = client.createFunction(
      {
        id: "test",
        triggers: [{ event: "demo/event.sent" }],
        optimizeParallelism: false,
      },
      () => "test",
    );

    const optedOutHandler = serve({ client, functions: [optedOutFn] });

    const result = await runHandler(optedOutHandler);

    expect(result.status).toBe(206);
    expect(result.headers[headerKeys.RequestVersion]).toBe(
      ExecutionVersion.V1.toString(),
    );
  });

  test("responds with V1 when client opts out of optimized parallelism", async () => {
    const client = createClient({
      id: "test",
      isDev: true,
      optimizeParallelism: false,
    });

    const fn = client.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );

    const handler = serve({ client, functions: [fn] });

    const result = await runHandler(handler);

    expect(result.status).toBe(206);
    expect(result.headers[headerKeys.RequestVersion]).toBe(
      ExecutionVersion.V1.toString(),
    );
  });

  test("function-level optimizeParallelism overrides client-level", async () => {
    const client = createClient({
      id: "test",
      isDev: true,
      optimizeParallelism: false,
    });

    const fnWithOverride = client.createFunction(
      {
        id: "test",
        triggers: [{ event: "demo/event.sent" }],
        optimizeParallelism: true,
      },
      () => "test",
    );

    const handler = serve({ client, functions: [fnWithOverride] });

    const result = await runHandler(handler);

    expect(result.status).toBe(206);
    expect(result.headers[headerKeys.RequestVersion]).toBe(
      ExecutionVersion.V2.toString(),
    );
  });
});

describe("RequestSignature", () => {
  const signingKey = "signkey-test-deadbeefcafef00d";
  const body = { event: { name: "demo/event.sent", data: {} } };
  const logger = new ConsoleLogger({ level: "silent" });

  const fixedNowMs = new Date("2026-04-22T12:00:00Z").getTime();
  const fixedNowSeconds = Math.round(fixedNowMs / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const verify = async (
    ts: string,
    { allowExpired = false }: { allowExpired?: boolean } = {},
  ) => {
    const mac = await signDataWithKey(body, signingKey, ts, logger);
    return new RequestSignature(`t=${ts}&s=${mac}`).verifySignature({
      body,
      signingKey,
      signingKeyFallback: undefined,
      allowExpiredSignatures: allowExpired,
      logger,
    });
  };

  describe("constructor", () => {
    test("throws when `t` is missing", () => {
      expect(() => new RequestSignature("s=abc")).toThrow(/Invalid/);
    });

    test("throws when `s` is missing", () => {
      expect(() => new RequestSignature("t=123")).toThrow(/Invalid/);
    });
  });

  describe("verifySignature expiry", () => {
    test("accepts a timestamp 60s in the future (tolerates clock skew)", async () => {
      await expect(verify((fixedNowSeconds + 60).toString())).resolves.toBe(
        signingKey,
      );
    });

    test("accepts a timestamp exactly 5 minutes old (boundary)", async () => {
      await expect(verify((fixedNowSeconds - 300).toString())).resolves.toBe(
        signingKey,
      );
    });

    test("rejects a timestamp older than 5 minutes", async () => {
      await expect(verify((fixedNowSeconds - 301).toString())).rejects.toThrow(
        "Signature has expired",
      );
    });

    test("rejects a timestamp more than 5 minutes in the future", async () => {
      await expect(verify((fixedNowSeconds + 301).toString())).rejects.toThrow(
        "Signature has expired",
      );
    });

    test("rejects an unparseable `t`", async () => {
      await expect(verify("not-a-number")).rejects.toThrow(
        "Signature has expired",
      );
    });

    test("rejects a hex-prefixed `t` (parseInt radix guard)", async () => {
      const hexTs = `0x${fixedNowSeconds.toString(16)}`;
      await expect(verify(hexTs)).rejects.toThrow("Signature has expired");
    });

    test.each([
      ["past", -3600],
      ["future", 3600],
    ])(
      "accepts a %s expired timestamp when allowExpiredSignatures is true",
      async (_label, offsetSeconds) => {
        await expect(
          verify((fixedNowSeconds + offsetSeconds).toString(), {
            allowExpired: true,
          }),
        ).resolves.toBe(signingKey);
      },
    );
  });

  describe("verifySignature signature check", () => {
    test("rejects a tampered signature", async () => {
      const ts = fixedNowSeconds.toString();
      const mac = await signDataWithKey(body, signingKey, ts, logger);
      const tampered = (mac[0] === "0" ? "1" : "0") + mac.slice(1);

      await expect(
        new RequestSignature(`t=${ts}&s=${tampered}`).verifySignature({
          body,
          signingKey,
          signingKeyFallback: undefined,
          allowExpiredSignatures: false,
          logger,
        }),
      ).rejects.toThrow("Invalid signature");
    });
  });
});

describe("introspection", () => {
  const logger = new ConsoleLogger({ level: "silent" });

  test("authenticated", async () => {
    const signingKey =
      "signkey-test-0000000000000000000000000000000000000000000000000000000000000000";
    const signingKeyFallback =
      "signkey-test-1111111111111111111111111111111111111111111111111111111111111111";

    const client = createClient({
      id: "test",
      isDev: false,
      signingKey,
      signingKeyFallback,
    });
    const commHandler = new InngestCommHandler({
      client,
      frameworkName: "test",
      functions: [],
      handler: (req: Request) => {
        return {
          body: () => req.text(),
          headers: (key: string) => req.headers.get(key),
          method: () => req.method,
          url: () => new URL(req.url),
          transformResponse: ({
            body,
            headers,
            status,
          }: {
            body: string;
            headers: Record<string, string>;
            status: number;
          }) => {
            return new Response(body, { status, headers });
          },
        };
      },
    });
    const handler = commHandler["createHandler"]();

    const timestamp = Math.round(Date.now() / 1000).toString();
    const signature = await signDataWithKey("", signingKey, timestamp, logger);
    const req = new Request("https://localhost:3000/api/inngest", {
      method: "GET",
      headers: {
        host: "localhost:3000",

        // Request signature is used to authenticate the request
        [headerKeys.Signature]: `t=${timestamp}&s=${signature}`,
      },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    // Authenticated response body (since signature is valid)
    expect(await res.json()).toEqual({
      api_origin: "https://api.inngest.com/",
      app_id: "test",
      authentication_succeeded: true,
      capabilities: { trust_probe: "v1", connect: "v1" },
      env: null,
      event_api_origin: "https://inn.gs/",
      event_key_hash: null,
      extra: {
        is_streaming: false,
        native_crypto: true,
      },
      framework: "test",
      function_count: 0,
      has_event_key: false,
      has_signing_key: true,
      mode: "cloud",
      schema_version: "2024-05-24",
      sdk_language: "js",
      sdk_version: expect.any(String),
      serve_origin: null,
      serve_path: null,

      // IMPORTANT: Only the first 12 characters of the hash are included
      signing_key_fallback_hash: "02d449a31fbb",
      signing_key_hash: "66687aadf862",
    });
  });

  test("wrong signature", async () => {
    const signingKey =
      "signkey-test-0000000000000000000000000000000000000000000000000000000000000000";
    const signingKeyFallback =
      "signkey-test-1111111111111111111111111111111111111111111111111111111111111111";
    const wrongSigningKey =
      "signkey-test-wrong-2222222222222222222222222222222222222222222222222222222222222222";

    const client = createClient({
      id: "test",
      isDev: false,
      signingKey,
      signingKeyFallback,
    });
    const commHandler = new InngestCommHandler({
      client,
      frameworkName: "test",
      functions: [],
      handler: (req: Request) => {
        return {
          body: () => req.text(),
          headers: (key: string) => req.headers.get(key),
          method: () => req.method,
          url: () => new URL(req.url),
          transformResponse: ({
            body,
            headers,
            status,
          }: {
            body: string;
            headers: Record<string, string>;
            status: number;
          }) => {
            return new Response(body, { status, headers });
          },
        };
      },
    });
    const handler = commHandler["createHandler"]();

    const timestamp = Math.round(Date.now() / 1000).toString();
    const signature = await signDataWithKey(
      "",
      wrongSigningKey,
      timestamp,
      logger,
    );
    const req = new Request("https://localhost:3000/api/inngest", {
      method: "GET",
      headers: {
        host: "localhost:3000",

        // Request signature is used to authenticate the request
        [headerKeys.Signature]: `t=${timestamp}&s=${signature}`,
      },
    });
    const res = await handler(req);
    // Cloud-mode GET with a wrong signature is now treated as unauthorized
    // — we no longer fall back to the unauthenticated introspection body.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Unauthorized" });
  });
});
