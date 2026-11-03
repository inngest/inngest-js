/**
 * @module
 * Type tests for `agent.start()`: its input is typed from the agent's
 * `invoke()` trigger, and is JSON content otherwise. `result()` is typed from
 * the agent's output.
 */
import { z } from "zod";
import { invoke } from "../../../components/triggers/triggers.ts";
import type { Json } from "../json.ts";
import type { StartedThread } from "./startThread.ts";
import { agents, typesOnly } from "./typeFixtures.ts";

describe("start types", () => {
  test("start: with an invoke() trigger the input is the trigger's data", () => {
    const worker = agents.agent({
      id: "start-typed",
      triggers: invoke(z.object({ question: z.string() })),
    });

    expectTypeOf(worker.start)
      .parameter(0)
      .toEqualTypeOf<{ question: string }>();

    typesOnly(() => {
      // @ts-expect-error the input must match the trigger's schema
      worker.start({ question: 1 });
    });
  });

  test("start: without an invoke() trigger the input is JSON content", () => {
    const worker = agents.agent({ id: "start-plain" });

    expectTypeOf(worker.start).parameter(0).toEqualTypeOf<Json>();
  });

  test("start: result is typed from the agent's output", async () => {
    const worker = agents.agent(
      { id: "start-output" },
      async (): Promise<{ done: boolean }> => {
        return { done: true };
      },
    );

    typesOnly(async () => {
      expectTypeOf(await worker.start("x").result()).toEqualTypeOf<{
        done: boolean;
      }>();
      expectTypeOf(await worker.start("x")).toEqualTypeOf<
        StartedThread<{ done: boolean }>
      >();
    });
  });
});
