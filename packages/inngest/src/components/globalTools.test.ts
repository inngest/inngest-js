/**
 * @module
 * Tests for the global `step` and `group` tools, and `inngest.globals()`.
 */

import { runFnWithStack } from "../test/helpers.ts";
import { Inngest } from "./Inngest.ts";
import {
  group as globalGroup,
  step as globalStep,
} from "./InngestStepTools.ts";
import { createScopeClient, runToEnd } from "./sandbox/test-helpers.ts";

const { client } = createScopeClient();
const { step, group } = client.globals();
const createOptions = { name: "box", vcpu: 2, memoryMb: 2048 };

/**
 * A helper that takes no `step` or `group`, like one in its own module.
 */
const buildInBox = async () => {
  const sandbox = await step.sandbox.create("box", createOptions);

  await sandbox.commands.run("run", "echo hi");
  await sandbox.destroy("box:destroy");
};

const buildInGroup = (): Promise<string> => {
  return group.sandbox("group-box", async (sandbox) => {
    await sandbox.commands.run("run", "echo hi");

    return "result";
  });
};

describe("global step and group", () => {
  test("`step.sandbox` works through a helper that is passed nothing", async () => {
    const { client } = createScopeClient();
    const fn = client.createFunction(
      { id: "global-step", triggers: [{ event: "global/step" }] },
      async () => {
        await buildInBox();
      },
    );

    const { type, ran } = await runToEnd(fn);

    expect(type).toBe("function-resolved");
    expect(ran).toEqual(["box", "run", "box:destroy"]);
  });

  test("`group.sandbox` works through a helper that is passed nothing", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "global-group", triggers: [{ event: "global/group" }] },
      async ({ step }) => {
        const result = await buildInGroup();

        await step.run("after", () => result);
      },
    );

    const { type, ran } = await runToEnd(fn);

    expect(type).toBe("function-resolved");
    expect(ran).toEqual(["group-box", "run", "group-box:destroy", "after"]);
    expect(calls.destroys).toBe(1);
  });

  test("steps run through it are found in the same tick as the function's own", async () => {
    const { client } = createScopeClient();
    const fn = client.createFunction(
      { id: "global-parallel", triggers: [{ event: "global/parallel" }] },
      async ({ step: ctxStep }) => {
        await Promise.all([
          globalStep.run("a", () => "a"),
          ctxStep.run("b", () => "b"),
          globalStep.run("c", () => "c"),
          globalStep.sleep("d", "1s"),
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
      expect(ret.steps.map((s) => s.userland?.id)).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
    }
  });

  test("`step.run` through it returns the run's own promise", async () => {
    const { client } = createScopeClient();
    const fn = client.createFunction(
      { id: "global-run", triggers: [{ event: "global/run" }] },
      async () => {
        const result = await globalStep.run("a", () => "value");

        await globalStep.run("b", () => result);
      },
    );

    const { type, ran } = await runToEnd(fn);

    expect(type).toBe("function-resolved");
    expect(ran).toEqual(["a", "b"]);
  });

  describe("outside a function run", () => {
    const message = /can only be used within Inngest function executions/;

    test("step tools reject with a clear error", async () => {
      await expect(globalStep.run("a", () => "a")).rejects.toThrow(message);
      await expect(globalStep.sleep("a", "1s")).rejects.toThrow(message);
    });

    test("middleware-added step tools reject with a clear error", async () => {
      await expect(step.sandbox.create("box", createOptions)).rejects.toThrow(
        message,
      );
      await expect(step.sandbox.python("a", "1")).rejects.toThrow(message);
    });

    test("group tools reject with a clear error", async () => {
      await expect(globalGroup.parallel(async () => undefined)).rejects.toThrow(
        message,
      );
      await expect(group.sandbox("box", async () => undefined)).rejects.toThrow(
        message,
      );
    });

    test("what needs no run still works", () => {
      expect(typeof globalStep.ai.models.openai).toBe("function");
      expect(typeof globalStep.fetch).toBe("function");
      expect(typeof globalGroup["~span"]).toBe("function");
    });

    test("is not mistaken for a thenable", async () => {
      expect(await Promise.resolve(globalStep)).toBe(globalStep);
    });
  });

  describe("types", () => {
    test("`inngest.globals()` carries the client's middleware", () => {
      expectTypeOf(step.sandbox.create).toBeFunction();
      expectTypeOf(group.sandbox).toBeFunction();
      expectTypeOf(step.run).toBeFunction();
      expectTypeOf(step.fetch).toBeFunction();
    });

    test("the plain global tools have no middleware tools", () => {
      // @ts-expect-error - `sandbox` is only on tools typed with the middleware
      void globalStep.sandbox;
      // @ts-expect-error - `sandbox` is only on tools typed with the middleware
      void globalGroup.sandbox;
    });

    test("a client without the middleware has no sandbox tools", () => {
      const plain = createPlain();
      const globals = plain.globals();

      // @ts-expect-error - no sandbox middleware on this client
      void globals.step.sandbox;
      // @ts-expect-error - no sandbox middleware on this client
      void globals.group.sandbox;
      expectTypeOf(globals.step.run).toBeFunction();
    });
  });
});

const createPlain = (): Inngest => {
  return new Inngest({ id: "plain" });
};
