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
import { Middleware } from "./middleware/middleware.ts";
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

  describe("concurrent runs", () => {
    const createTagged = (tag: string, delayMs: number) => {
      return client.createFunction(
        { id: `tagged-${tag}`, triggers: [{ event: `tagged/${tag}` }] },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          return globalStep.run(`step-${tag}`, () => tag);
        },
      );
    };

    test("two interleaved runs each reach their own steps", async () => {
      const slow = createTagged("slow", 20);
      const fast = createTagged("fast", 0);

      const [slowRun, fastRun] = await Promise.all([
        runFnWithStack(slow, {}),
        runFnWithStack(fast, {}),
      ]);

      expect(slowRun.type).toBe("step-ran");
      expect(fastRun.type).toBe("step-ran");

      if (slowRun.type === "step-ran" && fastRun.type === "step-ran") {
        expect(slowRun.step.userland?.id).toBe("step-slow");
        expect(slowRun.step.data).toBe("slow");
        expect(fastRun.step.userland?.id).toBe("step-fast");
        expect(fastRun.step.data).toBe("fast");
      }
    });

    test("interleaved runs through one shared helper keep their own sandboxes", async () => {
      const first = createScopeClient();
      const second = createScopeClient();
      const make = (
        scope: ReturnType<typeof createScopeClient>,
        id: string,
      ) => {
        return scope.client.createFunction(
          { id, triggers: [{ event: id }] },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            await buildInBox();
          },
        );
      };

      const [a, b] = await Promise.all([
        runToEnd(make(first, "a")),
        runToEnd(make(second, "b")),
      ]);

      expect(a.type).toBe("function-resolved");
      expect(b.type).toBe("function-resolved");
      expect(a.ran).toEqual(["box", "run", "box:destroy"]);
      expect(b.ran).toEqual(["box", "run", "box:destroy"]);
    });
  });

  describe("inside a run", () => {
    test("steps inside a group are found through the global tools", async () => {
      const { client } = createScopeClient();
      const fn = client.createFunction(
        { id: "global-nested", triggers: [{ event: "global/nested" }] },
        async () => {
          await globalGroup.parallel(async () => {
            return Promise.all([
              globalStep.run("a", () => "a"),
              globalStep.run("b", () => "b"),
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
        expect(ret.steps.map((s) => s.userland?.id)).toEqual(["a", "b"]);
      }
    });

    test("a reference saved at module scope works when called in a run", async () => {
      const { run } = globalStep;
      const { create } = step.sandbox;
      const { client } = createScopeClient();
      const fn = client.createFunction(
        { id: "global-saved", triggers: [{ event: "global/saved" }] },
        async () => {
          await run("saved", () => "saved");
          await create("saved-box", createOptions);
        },
      );

      const { type, ran } = await runToEnd(fn);

      expect(type).toBe("function-resolved");
      expect(ran).toEqual(["saved", "saved-box"]);
    });

    test("a saved group reference works when called in a run", async () => {
      const { parallel } = globalGroup;
      const { client } = createScopeClient();
      const fn = client.createFunction(
        {
          id: "global-saved-group",
          triggers: [{ event: "global/saved-group" }],
        },
        async () => {
          await parallel(async () => globalStep.run("in-group", () => "a"));
        },
      );

      const ret = await runFnWithStack(
        fn,
        {},
        { disableImmediateExecution: true },
      );

      expect(ret.type).toBe("steps-found");
    });

    test("a saved reference called outside a run rejects", async () => {
      const { run } = globalStep;

      await expect(run("a", () => "a")).rejects.toThrow(
        /can only be used within Inngest function executions/,
      );
    });

    test("an unknown tool rejects as not a function", async () => {
      const { client } = createScopeClient();
      const fn = client.createFunction(
        { id: "global-unknown", triggers: [{ event: "global/unknown" }] },
        async () => {
          await (globalStep as unknown as { nope: () => Promise<void> }).nope();
        },
      );

      const { type } = await runToEnd(fn);

      expect(type).toBe("function-rejected");
    });

    test("tools added by custom middleware work and are typed", async () => {
      class DoubleMiddleware extends Middleware.BaseMiddleware {
        readonly id = "test:double";

        override transformFunctionInput(
          arg: Middleware.TransformFunctionInputArgs,
        ) {
          const { step } = arg.ctx;

          return {
            ...arg,
            ctx: {
              ...arg.ctx,
              step: {
                ...step,
                double: (id: string, n: number) => {
                  return step.run(id, () => n * 2);
                },
              },
            },
          };
        }
      }

      const custom = new Inngest({
        id: "custom",
        middleware: [DoubleMiddleware],
      });
      const { step: customStep } = custom.globals();
      const fn = custom.createFunction(
        { id: "global-custom", triggers: [{ event: "global/custom" }] },
        async () => {
          const doubled = await customStep.double("twice", 21);

          await customStep.run("check", () => doubled);
        },
      );

      expectTypeOf(customStep.double).parameters.toEqualTypeOf<
        [string, number]
      >();

      const { type, steps } = await runToEnd(fn);

      expect(type).toBe("function-resolved");
      expect(steps.map((s) => s.data)).toEqual([42, 42]);
    });

    test("`step.fetch` creates a durable gateway step", async () => {
      const { client } = createScopeClient();
      const fn = client.createFunction(
        { id: "global-fetch", triggers: [{ event: "global/fetch" }] },
        async () => {
          await globalStep.fetch("https://example.test/");
        },
      );

      const ret = await runFnWithStack(fn, {});

      expect(ret.type).toBe("steps-found");
      if (ret.type === "steps-found") {
        expect(ret.steps.map((s) => s.op)).toEqual(["Gateway"]);
      }
    });
  });

  describe("after a run ends", () => {
    test("a dangling call behaves like the function's own step, without crashing", async () => {
      const { client } = createScopeClient();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      let global: Promise<unknown> | undefined;
      let own: Promise<unknown> | undefined;
      const fn = client.createFunction(
        { id: "global-dangling", triggers: [{ event: "global/dangling" }] },
        async ({ step: ctxStep }) => {
          setTimeout(() => {
            global = globalStep.run("late", () => "late");
            own = ctxStep.run("late-own", () => "late");
          }, 5);
        },
      );

      const { type } = await runToEnd(fn);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const pending = Symbol("pending");
      const settle = (promise: Promise<unknown> | undefined) => {
        return Promise.race([
          promise,
          new Promise((resolve) => setTimeout(() => resolve(pending), 100)),
        ]);
      };

      process.off("unhandledRejection", onUnhandled);

      expect(type).toBe("function-resolved");
      expect(await settle(global)).toBe(await settle(own));
      expect(unhandled).toEqual([]);
    });
  });

  describe("what users do with the proxies", () => {
    test("`typeof` is right for tools and namespaces", () => {
      expect(typeof globalStep).toBe("object");
      expect(typeof globalGroup).toBe("object");
      expect(typeof globalStep.run).toBe("function");
      expect(typeof globalStep.ai).toBe("object");
      expect(typeof globalStep.realtime).toBe("object");
    });

    test("`in` finds base tools, and run tools when in a run", async () => {
      expect("fetch" in globalStep).toBe(true);
      expect("ai" in globalStep).toBe(true);
      expect("run" in globalStep).toBe(false);

      const { client } = createScopeClient();
      let found: boolean[] = [];
      const { step: scoped } = client.globals();
      const fn = client.createFunction(
        { id: "global-in", triggers: [{ event: "global/in" }] },
        async () => {
          found = [
            "run" in scoped,
            "sandbox" in scoped,
            "nope" in scoped,
            "parallel" in globalGroup,
          ];
        },
      );

      await runToEnd(fn);

      expect(found).toEqual([true, true, false, true]);
    });

    test("spreading gives only what works outside a run", () => {
      expect(Object.keys({ ...globalStep }).sort()).toEqual([
        "ai",
        "fetch",
        "realtime",
      ]);
    });
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

    test("nested tools reject with a clear error", async () => {
      await expect(globalStep.ai.infer("a", {} as never)).rejects.toThrow(
        message,
      );
      await expect(
        globalStep.realtime.publish("a", {} as never, {} as never),
      ).rejects.toThrow(message);
      await expect(
        (globalStep as unknown as { a: { b: { c: () => void } } }).a.b.c(),
      ).rejects.toThrow(message);
    });

    test("nested stand-ins are not mistaken for thenables", async () => {
      const nested = (globalStep as unknown as { a: { b: unknown } }).a.b;

      expect(await Promise.resolve(nested)).toBe(nested);
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

    test("misuse is a type error", () => {
      const misuse = () => {
        // @ts-expect-error - missing the step ID
        void step.run(() => "a");
        // @ts-expect-error - sandbox.create needs an ID
        void step.sandbox.create();
        // @ts-expect-error - not a step tool
        void step.nope;
        // @ts-expect-error - not a group tool
        void group.nope;
        // @ts-expect-error - globals takes no arguments
        void client.globals({ step: {} });
      };

      expect(misuse).toBeTypeOf("function");
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
