import { describe, expect, test } from "vitest";
import { ExecutionVersion } from "../helpers/consts.ts";
import { createClient, runFnWithStack } from "../test/helpers.ts";
import { StepOpCode } from "../types.ts";
import { InngestCommHandler } from "./InngestCommHandler.ts";

describe("EXE-1135: Default to optimized parallelism", () => {
  describe("shouldOptimizeParallelism precedence", () => {
    // Function-level takes priority over client-level, which takes priority over default (true)
    test.each([
      {
        fn: undefined,
        client: undefined,
        expected: true,
        desc: "defaults to true",
      },
      {
        fn: false,
        client: undefined,
        expected: false,
        desc: "function false wins",
      },
      {
        fn: undefined,
        client: false,
        expected: false,
        desc: "client false wins",
      },
      {
        fn: true,
        client: false,
        expected: true,
        desc: "function true overrides client false",
      },
      {
        fn: false,
        client: true,
        expected: false,
        desc: "function false overrides client true",
      },
    ])(
      "returns $expected when function=$fn, client=$client ($desc)",
      ({ fn, client, expected }) => {
        const clientInstance = createClient({
          id: "test",
          isDev: true,
          ...(client !== undefined && { optimizeParallelism: client }),
        });
        const fnInstance = clientInstance.createFunction(
          {
            id: "test-fn",
            ...(fn !== undefined && { optimizeParallelism: fn }),
          },
          { event: "test/event" },
          async ({ step }) => {
            await step.run("a", () => "a");
          },
        );

        expect(fnInstance["shouldOptimizeParallelism"]()).toBe(expected);
      },
    );
  });

  describe("parallelMode step option", () => {
    test("propagates parallelMode to step.run ops", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          await Promise.race([
            step.run({ id: "a", parallelMode: "race" }, () => "a"),
            step.run({ id: "b", parallelMode: "race" }, () => "b"),
          ]);
        },
      );

      const ret = await runFnWithStack(
        fn,
        {},
        { disableImmediateExecution: true },
      );

      expect(ret.type).toBe("steps-found");
      if (ret.type === "steps-found") {
        expect(ret.steps.length).toBeGreaterThan(0);
        for (const op of ret.steps) {
          expect(op.op).toBe(StepOpCode.StepPlanned);
          expect(op.opts).toMatchObject({ parallelMode: "race" });
        }
      }
    });

    test("omits parallelMode from ops when not specified", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          await Promise.all([
            step.run("a", () => "a"),
            step.run("b", () => "b"),
          ]);
        },
      );

      const ret = await runFnWithStack(
        fn,
        {},
        { disableImmediateExecution: true },
      );

      expect(ret.type).toBe("steps-found");
      if (ret.type === "steps-found") {
        for (const op of ret.steps) {
          expect(op.opts ?? {}).not.toHaveProperty("parallelMode");
        }
      }
    });

    test("propagates parallelMode to step.sleep ops", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          await Promise.race([
            step.run({ id: "a", parallelMode: "race" }, () => "a"),
            step.sleep({ id: "wait", parallelMode: "race" }, "1h"),
          ]);
        },
      );

      const ret = await runFnWithStack(
        fn,
        {},
        { disableImmediateExecution: true },
      );

      expect(ret.type).toBe("steps-found");
      if (ret.type === "steps-found") {
        for (const op of ret.steps) {
          expect(op.opts).toMatchObject({ parallelMode: "race" });
        }
      }
    });

    test("propagates parallelMode to step.waitForEvent ops", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          await Promise.race([
            step.run({ id: "work", parallelMode: "race" }, () => "done"),
            step.waitForEvent(
              { id: "external", parallelMode: "race" },
              { event: "external/event", timeout: "1h" },
            ),
          ]);
        },
      );

      const ret = await runFnWithStack(
        fn,
        {},
        { disableImmediateExecution: true },
      );

      expect(ret.type).toBe("steps-found");
      if (ret.type === "steps-found") {
        expect(ret.steps).toHaveLength(2);
        for (const op of ret.steps) {
          expect(op.opts).toMatchObject({ parallelMode: "race" });
        }
      }
    });

    test("propagates parallelMode even when optimizeParallelism is false", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn", optimizeParallelism: false },
        { event: "test/event" },
        async ({ step }) => {
          await Promise.race([
            step.run({ id: "a", parallelMode: "race" }, () => "a"),
            step.run({ id: "b", parallelMode: "race" }, () => "b"),
          ]);
        },
      );

      const ret = await runFnWithStack(
        fn,
        {},
        { disableImmediateExecution: true },
      );

      expect(ret.type).toBe("steps-found");
      if (ret.type === "steps-found") {
        for (const op of ret.steps) {
          expect(op.opts).toMatchObject({ parallelMode: "race" });
        }
      }
    });
  });

  describe("execution version selection", () => {
    const sdkDecidesRequestBody = {
      event: { name: "test/event", data: {} },
      events: [{ name: "test/event", data: {} }],
      steps: {},
      ctx: { run_id: "run-123", attempt: 0 },
      version: -1, // SDK decides
    };

    const createHandler = (
      client: ReturnType<typeof createClient>,
      fn: ReturnType<ReturnType<typeof createClient>["createFunction"]>,
    ) => {
      const bodyStr = JSON.stringify(sdkDecidesRequestBody);
      return new InngestCommHandler({
        frameworkName: "test",
        client,
        functions: [fn],
        handler: () => ({
          body: () => sdkDecidesRequestBody,
          headers: (key: string) =>
            key.toLowerCase() === "content-length"
              ? bodyStr.length.toString()
              : undefined,
          method: () => "POST",
          url: () => new URL("http://localhost/api/inngest?fnId=test-test-fn"),
          queryString: (key: string) =>
            new URLSearchParams("fnId=test-test-fn").get(key) ?? undefined,
          transformResponse: ({ headers, status, body }) => ({
            headers,
            status,
            body,
          }),
        }),
      });
    };

    test.each([
      {
        fnOpt: undefined,
        clientOpt: undefined,
        expectedVersion: ExecutionVersion.V2,
        desc: "default",
      },
      {
        fnOpt: false,
        clientOpt: undefined,
        expectedVersion: ExecutionVersion.V1,
        desc: "function opt-out",
      },
      {
        fnOpt: undefined,
        clientOpt: false,
        expectedVersion: ExecutionVersion.V1,
        desc: "client opt-out",
      },
    ])(
      "uses V$expectedVersion with $desc",
      async ({ fnOpt, clientOpt, expectedVersion }) => {
        const client = createClient({
          id: "test",
          isDev: true,
          ...(clientOpt !== undefined && { optimizeParallelism: clientOpt }),
        });
        const fn = client.createFunction(
          {
            id: "test-fn",
            ...(fnOpt !== undefined && { optimizeParallelism: fnOpt }),
          },
          { event: "test/event" },
          async () => "done",
        );

        const handler = createHandler(client, fn);
        const response = (await handler.createHandler()()) as {
          headers: Record<string, string>;
        };

        expect(response.headers["x-inngest-req-version"]).toBe(
          expectedVersion.toString(),
        );
      },
    );
  });
});
