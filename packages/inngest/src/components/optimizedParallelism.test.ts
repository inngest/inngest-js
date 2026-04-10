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
            triggers: [{ event: "test/event" }],
          },
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
        { id: "test-fn", triggers: [{ event: "test/event" }] },
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
        { id: "test-fn", triggers: [{ event: "test/event" }] },
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
        { id: "test-fn", triggers: [{ event: "test/event" }] },
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
        { id: "test-fn", triggers: [{ event: "test/event" }] },
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
        {
          id: "test-fn",
          optimizeParallelism: false,
          triggers: [{ event: "test/event" }],
        },
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

  describe("group.parallel() helper", () => {
    test("automatically sets parallelMode and raceGroupId on steps inside callback", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn", triggers: [{ event: "test/event" }] },
        async ({ step, group }) => {
          await group.parallel(async () => {
            return Promise.race([
              step.run("a", () => "a"),
              step.run("b", () => "b"),
              step.run("c", () => "c"),
            ]);
          });
        },
      );

      const ret = await runFnWithStack(
        fn,
        {},
        { disableImmediateExecution: true },
      );

      expect(ret.type).toBe("steps-found");
      if (ret.type === "steps-found") {
        expect(ret.steps).toHaveLength(3);
        const groupId = ret.steps[0]?.opts?.raceGroupId;
        expect(groupId).toEqual(expect.any(String));
        for (const op of ret.steps) {
          expect(op.op).toBe(StepOpCode.StepPlanned);
          expect(op.opts).toMatchObject({
            parallelMode: "race",
            raceGroupId: groupId,
          });
        }
      }
    });

    test("does not affect steps outside the callback", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn", triggers: [{ event: "test/event" }] },
        async ({ step, group }) => {
          // This step is outside group.parallel() - should NOT have parallelMode
          const outside = step.run("outside", () => "outside");

          await group.parallel(async () => {
            return Promise.race([
              step.run("inside-a", () => "a"),
              step.run("inside-b", () => "b"),
            ]);
          });

          await outside;
        },
      );

      const ret = await runFnWithStack(
        fn,
        {},
        { disableImmediateExecution: true },
      );

      expect(ret.type).toBe("steps-found");
      if (ret.type === "steps-found") {
        expect(ret.steps).toHaveLength(3);

        const outsideStep = ret.steps.find((s) => s.displayName === "outside");
        const insideSteps = ret.steps.filter((s) =>
          s.displayName?.startsWith("inside-"),
        );

        expect(outsideStep).toBeDefined();
        expect(outsideStep?.opts?.parallelMode).toBeUndefined();
        expect(outsideStep?.opts?.raceGroupId).toBeUndefined();

        expect(insideSteps).toHaveLength(2);
        const groupId = insideSteps[0]?.opts?.raceGroupId;
        expect(groupId).toEqual(expect.any(String));
        for (const op of insideSteps) {
          expect(op.opts).toMatchObject({
            parallelMode: "race",
            raceGroupId: groupId,
          });
        }
      }
    });

    test("group.parallel() context applies to all steps in callback", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn", triggers: [{ event: "test/event" }] },
        async ({ step, group }) => {
          await group.parallel({ mode: "race" }, async () => {
            return Promise.race([
              step.run("a", () => "a"),
              step.run({ id: "b" }, () => "b"),
            ]);
          });
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

        const groupId = ret.steps[0]?.opts?.raceGroupId;
        expect(groupId).toEqual(expect.any(String));
        // Both steps should have parallelMode and the same raceGroupId
        for (const op of ret.steps) {
          expect(op.opts).toMatchObject({
            parallelMode: "race",
            raceGroupId: groupId,
          });
        }
      }
    });

    test("works with all step types (sleep, waitForEvent)", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn", triggers: [{ event: "test/event" }] },
        async ({ step, group }) => {
          await group.parallel(async () => {
            return Promise.race([
              step.run("work", () => "done"),
              step.sleep("timeout", "10s"),
              step.waitForEvent("external", {
                event: "external/event",
                timeout: "1h",
              }),
            ]);
          });
        },
      );

      const ret = await runFnWithStack(
        fn,
        {},
        { disableImmediateExecution: true },
      );

      expect(ret.type).toBe("steps-found");
      if (ret.type === "steps-found") {
        expect(ret.steps).toHaveLength(3);
        const groupId = ret.steps[0]?.opts?.raceGroupId;
        expect(groupId).toEqual(expect.any(String));
        for (const op of ret.steps) {
          expect(op.opts).toMatchObject({
            parallelMode: "race",
            raceGroupId: groupId,
          });
        }
      }
    });

    test("concurrent group.parallel() calls get different raceGroupIds", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn", triggers: [{ event: "test/event" }] },
        async ({ step, group }) => {
          // Two group.parallel() calls started concurrently via Promise.all.
          // Each should get a distinct raceGroupId.
          await Promise.all([
            group.parallel(async () => {
              return Promise.race([
                step.run("first-a", () => "a"),
                step.run("first-b", () => "b"),
              ]);
            }),
            group.parallel(async () => {
              return Promise.race([
                step.run("second-a", () => "a"),
                step.run("second-b", () => "b"),
              ]);
            }),
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
        expect(ret.steps).toHaveLength(4);

        const firstSteps = ret.steps.filter((s) =>
          s.displayName?.startsWith("first-"),
        );
        const secondSteps = ret.steps.filter((s) =>
          s.displayName?.startsWith("second-"),
        );

        expect(firstSteps).toHaveLength(2);
        expect(secondSteps).toHaveLength(2);

        const firstGroupId = firstSteps[0]?.opts?.raceGroupId;
        const secondGroupId = secondSteps[0]?.opts?.raceGroupId;

        expect(firstGroupId).toEqual(expect.any(String));
        expect(secondGroupId).toEqual(expect.any(String));

        // Steps within the same group share the same raceGroupId
        for (const op of firstSteps) {
          expect(op.opts?.raceGroupId).toBe(firstGroupId);
        }
        for (const op of secondSteps) {
          expect(op.opts?.raceGroupId).toBe(secondGroupId);
        }

        // The two groups have different raceGroupIds
        expect(firstGroupId).not.toBe(secondGroupId);
      }
    });

    test("steps outside group.parallel() do not get raceGroupId", async () => {
      const client = createClient({ id: "test", isDev: true });
      const fn = client.createFunction(
        { id: "test-fn", triggers: [{ event: "test/event" }] },
        async ({ step }) => {
          await Promise.all([
            step.run("plain-a", () => "a"),
            step.run("plain-b", () => "b"),
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
          expect(op.opts?.raceGroupId).toBeUndefined();
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
            triggers: [{ event: "test/event" }],
          },
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
