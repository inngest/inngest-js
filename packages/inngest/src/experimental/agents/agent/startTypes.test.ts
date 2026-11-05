/**
 * @module
 * Type tests for `agent.start()`: its input is typed from the agent's
 * `invoke()` trigger, and is JSON content otherwise. `result()` is typed from
 * the agent's output.
 */
import { z } from "zod";
import { eventType, invoke } from "../../../components/triggers/triggers.ts";
import type { EventIs } from "../../../components/triggers/typeHelpers.ts";
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

  test("reports are plain event types and keep the event type's own data", () => {
    const milestone = eventType("milestone", {
      schema: z.object({ reached: z.string() }),
    });
    const worker = agents.agent({ id: "reports-worker" }, async ({ me }) => {
      typesOnly(async () => {
        await me.report(milestone, { reached: "half" });
        // @ts-expect-error the data must fit the event type's schema
        await me.report(milestone, { reached: 1 });
      });
    });

    agents.agent({ id: "reports-boss" }, async ({ me, inbox }) => {
      typesOnly(async () => {
        // An event type alone, or a line with where it goes.
        await worker.start("x", {
          reports: [
            milestone,
            { event: milestone, to: me, if: "async.data.reached == 'x'" },
            { event: milestone, required: true },
          ],
        });
        // @ts-expect-error a line names an event type
        await worker.start("x", { reports: [{ to: me }] });

        await inbox.next();

        // The inbox narrows by `is()` as it does any event type: the data is
        // the event type's own.
        const message = {} as {
          name: string;
          data: Record<string, unknown>;
        } & EventIs;

        if (message.is(milestone)) {
          expectTypeOf(message.data.reached).toBeString();
        }
      });

      return undefined;
    });
  });
});
