/**
 * @module
 * A read waiting for a message counts as an unfinished op beside a sibling
 * step, so the step is planned for the executor and never run in-process. An
 * in-process step's place in the stack would be decided by when its checkpoint
 * lands, not by when it finished.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { hashedStepId } from "../execution/inboxState.ts";
import { Inngest } from "../Inngest.ts";

describe("a step beside a waiting read", () => {
  test.each([false, true])(
    "is planned, not run in-process (optimizeParallelism %s)",
    async (optimizeParallelism) => {
      const ran: string[] = [];
      const fn = new Inngest({ id: testClientId, isDev: true }).createFunction(
        {
          id: "race-wait",
          triggers: [{ event: "race/wait" }],
          optimizeParallelism,
        },
        async ({ step }) => {
          const inbox = step.subscribe("inbox", "msg");

          return Promise.race([
            step.run("slow", () => {
              ran.push("slow");

              return "slow-done";
            }),
            inbox.next(),
          ]);
        },
      );
      const opened = hashedStepId("inbox");

      const result = await runFnWithStack(fn, {
        [opened]: { id: opened, data: { pauses: [] } },
      });

      expect(ran).toEqual([]);
      expect(result).toMatchObject({
        type: "steps-found",
        steps: [{ op: "StepPlanned" }, { op: "SubscribeWait" }],
      });
    },
  );
});
