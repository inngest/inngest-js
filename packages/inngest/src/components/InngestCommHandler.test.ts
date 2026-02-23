import httpMocks from "node-mocks-http";
import { ExecutionVersion, envKeys, headerKeys } from "../helpers/consts.ts";
import { InngestCommHandler } from "../index.ts";
import { serve } from "../next.ts";
import { createClient } from "../test/helpers.ts";
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

    expect(result.status).toBe(200);
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

    expect(result.status).toBe(200);
    expect(result.headers[headerKeys.RequestVersion]).toBe(
      ExecutionVersion.V2.toString(),
    );
  });

  test("responds with V2 when no version in request", async () => {
    const result = await runHandler(handler);

    expect(result.status).toBe(200);
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

    expect(result.status).toBe(200);
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

    expect(result.status).toBe(200);
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

    expect(result.status).toBe(200);
    expect(result.headers[headerKeys.RequestVersion]).toBe(
      ExecutionVersion.V2.toString(),
    );
  });
});
