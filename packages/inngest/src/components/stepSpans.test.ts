import { openai } from "@inngest/ai";
import { describe, expect, test } from "vitest";
import { createClient, runFnWithStack } from "../test/helpers.ts";
import type { OutgoingOp } from "../types.ts";
import type { InngestFunction } from "./InngestFunction.ts";
import { createGroupTools } from "./InngestGroupTools.ts";

const client = createClient({ id: "test", isDev: true });

const other = client.createFunction(
  { id: "other", triggers: [{ event: "other" }] },
  () => "other",
);

/**
 * Find every step `fn` reports in parallel on its first request, keyed by
 * step ID.
 */
const findSteps = async (fn: InngestFunction.Any) => {
  const ret = await runFnWithStack(fn, {}, { disableImmediateExecution: true });

  if (ret.type !== "steps-found") {
    throw new Error(`Expected steps-found, got ${ret.type}`);
  }

  return Object.fromEntries(
    ret.steps.map((op) => {
      return [op.userland?.id ?? op.id, op];
    }),
  );
};

/**
 * Run `fn` request by request, memoizing each new step, and return the steps
 * in the order they ran.
 */
const runSteps = async (fn: InngestFunction.Any, count: number) => {
  const steps: OutgoingOp[] = [];
  let state: Record<string, { id: string; data: unknown }> = {};

  for (let i = 0; i < count; i++) {
    const ret = await runFnWithStack(fn, state, {
      stackOrder: steps.map(({ id }) => id),
    });

    if (ret.type !== "step-ran") {
      throw new Error(`Expected step-ran, got ${ret.type}`);
    }

    steps.push(ret.step);
    state = { ...state, [ret.step.id]: { id: ret.step.id, data: null } };
  }

  return steps;
};

const outer = { id: "research", name: "Research agent" };
const inner = { id: "search", name: "search" };

describe('group["~span"]()', () => {
  test("stamps the span path on every step type in nested spans", async () => {
    const fn = client.createFunction(
      { id: "fn", triggers: [{ event: "test" }] },
      async ({ step, group }) => {
        await group["~span"]({ id: "research", name: "Research agent" }, () => {
          return Promise.all([
            step.run("plan", () => "plan"),
            group["~span"]({ id: "search" }, () => {
              return Promise.all([
                step.run("run", () => "run"),
                step.sleep("sleep", "1s"),
                step.waitForEvent("wait", { event: "e", timeout: "1h" }),
                step.invoke("invoke", { function: other }),
                step.ai.infer("infer", {
                  model: openai({ model: "gpt-4o", apiKey: "key" }),
                  body: { messages: [] },
                }),
              ]);
            }),
          ]);
        });
      },
    );

    const steps = await findSteps(fn);

    expect(steps.plan?.opts?.span).toEqual([outer]);

    for (const id of ["run", "sleep", "wait", "invoke", "infer"]) {
      expect(steps[id]?.opts?.span).toEqual([outer, inner]);
    }
  });

  test("sends no span key for steps outside any span", async () => {
    const fn = client.createFunction(
      { id: "fn", triggers: [{ event: "test" }] },
      async ({ step, group }) => {
        const outside = step.run("outside", () => "outside");

        await group["~span"]({ id: "research" }, () => {
          return step.run("inside", () => "inside");
        });

        await Promise.all([outside, step.sleep("after", "1s")]);
      },
    );

    const steps = await findSteps(fn);

    expect(steps.outside?.opts ?? {}).not.toHaveProperty("span");
    expect(steps.inside?.opts?.span).toEqual([
      { id: "research", name: "research" },
    ]);
  });

  test("appends the step option to the span scope", async () => {
    const fn = client.createFunction(
      { id: "fn", triggers: [{ event: "test" }] },
      async ({ step, group }) => {
        await Promise.all([
          step.run({ id: "alone", "~span": inner }, () => "alone"),
          group["~span"](outer, () => {
            return step.run({ id: "nested", "~span": inner }, () => "nested");
          }),
        ]);
      },
    );

    const steps = await findSteps(fn);

    expect(steps.alone?.opts?.span).toEqual([inner]);
    expect(steps.nested?.opts?.span).toEqual([outer, inner]);
  });

  test("re-enters a span opened again with the same ID", async () => {
    const fn = client.createFunction(
      { id: "fn", triggers: [{ event: "test" }] },
      async ({ step, group }) => {
        await group["~span"](outer, () => {
          return step.run("start", () => "start");
        });

        await group["~span"](outer, () => {
          return step.run("finish", () => "finish");
        });
      },
    );

    const [start, finish] = await runSteps(fn, 2);

    expect(start?.opts?.span).toEqual([outer]);
    expect(finish?.opts?.span).toEqual([outer]);
  });

  test("stamps the same span paths on every replay", async () => {
    const fn = client.createFunction(
      { id: "fn", triggers: [{ event: "test" }] },
      async ({ step, group }) => {
        await group["~span"](outer, async () => {
          await step.run("a", () => "a");

          await group["~span"](inner, async () => {
            await step.run("b", () => "b");
            await step.run("c", () => "c");
          });
        });
      },
    );

    const spans = async () => {
      const steps = await runSteps(fn, 3);

      return steps.map(({ id, opts }) => {
        return { id, span: opts?.span };
      });
    };

    const first = await spans();

    expect(first.map(({ span }) => span)).toEqual([
      [outer],
      [outer, inner],
      [outer, inner],
    ]);
    expect(await spans()).toEqual(first);
  });

  test("runs the callback ungrouped outside an execution", () => {
    const group = createGroupTools();

    expect(group["~span"](outer, () => "result")).toBe("result");
  });

  test("runs the callback ungrouped without AsyncLocalStorage", async () => {
    const cache = (globalThis as Record<symbol, { resolved?: unknown }>)[
      Symbol.for("inngest:als")
    ];

    if (!cache) {
      throw new Error("Expected AsyncLocalStorage to be initialized");
    }

    const resolved = cache.resolved;

    cache.resolved = {
      getStore: () => {
        return undefined;
      },
      run: (_store: unknown, fn: () => unknown) => {
        return fn();
      },
    };

    try {
      const fn = client.createFunction(
        { id: "fn", triggers: [{ event: "test" }] },
        async ({ step, group }) => {
          await group["~span"](outer, () => {
            return step.run("inside", () => "inside");
          });
        },
      );

      const [inside] = await runSteps(fn, 1);

      expect(inside?.opts ?? {}).not.toHaveProperty("span");
    } finally {
      cache.resolved = resolved;
    }
  });
});
