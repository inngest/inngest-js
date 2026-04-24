import httpMocks from "node-mocks-http";
import { ExecutionVersion, envKeys, headerKeys } from "../helpers/consts.ts";
import { serve } from "../next.ts";
import { createClient, makeTestSignature } from "../test/helpers.ts";
import { internalLoggerSymbol } from "./Inngest.ts";

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

describe("GET introspection", () => {
  const runGet = async (
    handler: ReturnType<typeof serve>,
    opts?: { signature?: string; env?: Record<string, string> },
  ) => {
    const headers: Record<string, string> = {
      host: "localhost:3000",
      "content-type": "application/json",
    };
    if (opts?.signature !== undefined) {
      headers[headerKeys.Signature] = opts.signature;
    }

    const req = httpMocks.createRequest({
      method: "GET",
      url: "/api/inngest",
      headers,
    });
    const res = httpMocks.createResponse();

    const prevEnv = process.env;
    if (opts?.env) {
      process.env = { ...prevEnv, ...opts.env };
    }

    try {
      await (handler as (...args: unknown[]) => Promise<unknown>)(req, res);
      return {
        status: res.statusCode,
        body: JSON.parse(res._getData() || "{}") as Record<string, unknown>,
        headers: res.getHeaders() as Record<string, string>,
      };
    } finally {
      process.env = prevEnv;
    }
  };

  test("dev mode returns unauthenticated introspection body", async () => {
    const inngest = createClient({ id: "test", isDev: true });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );
    const handler = serve({ client: inngest, functions: [fn] });

    const result = await runGet(handler);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      function_count: 1,
      has_event_key: expect.any(Boolean),
      has_signing_key: expect.any(Boolean),
      mode: "dev",
      schema_version: "2024-05-24",
    });
    expect(result.body).not.toHaveProperty("authentication_succeeded");
  });

  test("cloud mode without a signature returns 401", async () => {
    const inngest = createClient({ id: "test", isDev: false });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );
    const handler = serve({ client: inngest, functions: [fn] });

    const result = await runGet(handler, {
      env: { [envKeys.InngestSigningKey]: "signkey-prod-12345" },
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ code: "sig_verification_failed" });
  });

  test("cloud mode with an invalid signature returns 401", async () => {
    const inngest = createClient({ id: "test", isDev: false });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );
    const handler = serve({ client: inngest, functions: [fn] });

    const result = await runGet(handler, {
      signature:
        "t=1700000000&s=0000000000000000000000000000000000000000000000000000000000000000",
      env: { [envKeys.InngestSigningKey]: "signkey-prod-12345" },
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ code: "sig_verification_failed" });
  });

  test("cloud mode 401 body does not leak introspection fields", async () => {
    const inngest = createClient({ id: "test", isDev: false });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );
    const handler = serve({ client: inngest, functions: [fn] });

    const result = await runGet(handler, {
      env: { [envKeys.InngestSigningKey]: "signkey-prod-12345" },
    });

    expect(result.body).not.toHaveProperty("function_count");
    expect(result.body).not.toHaveProperty("has_event_key");
    expect(result.body).not.toHaveProperty("has_signing_key");
    expect(result.body).not.toHaveProperty("mode");
    expect(result.body).not.toHaveProperty("schema_version");
    expect(result.body).not.toHaveProperty("extra");
  });

  test("cloud mode 401 response does not leak SDK fingerprint headers", async () => {
    const inngest = createClient({ id: "test", isDev: false });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );
    const handler = serve({ client: inngest, functions: [fn] });

    const result = await runGet(handler, {
      env: { [envKeys.InngestSigningKey]: "signkey-prod-12345" },
    });

    expect(result.headers).not.toHaveProperty(
      headerKeys.SdkVersion.toLowerCase(),
    );
    expect(result.headers).not.toHaveProperty(
      headerKeys.Framework.toLowerCase(),
    );
    expect(result.headers).not.toHaveProperty(
      headerKeys.Platform.toLowerCase(),
    );
    expect(result.headers).not.toHaveProperty(
      headerKeys.Environment.toLowerCase(),
    );
    expect(result.headers).not.toHaveProperty(
      headerKeys.InngestExpectedServerKind.toLowerCase(),
    );
    expect(result.headers).not.toHaveProperty(
      headerKeys.RequestVersion.toLowerCase(),
    );
    expect(result.headers).not.toHaveProperty("user-agent");
  });

  test("cloud mode with a valid signature returns authenticated body", async () => {
    const inngest = createClient({ id: "test", isDev: false });
    const fn = inngest.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "test",
    );
    const handler = serve({ client: inngest, functions: [fn] });

    const signingKey = "signkey-prod-12345";
    const result = await runGet(handler, {
      signature: await makeTestSignature("", signingKey),
      env: { [envKeys.InngestSigningKey]: signingKey },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      authentication_succeeded: true,
      mode: "cloud",
      sdk_language: "js",
      function_count: 1,
    });
  });
});
