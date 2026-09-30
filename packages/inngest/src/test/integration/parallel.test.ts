import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";
import { matrixCheckpointing } from "./utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

matrixCheckpointing(
  "does not re-execute a pending step when another parallel step finishes",
  async (checkpointing) => {
    const state = createState({
      attempts: {
        A: [] as number[],
        B: [] as number[],
        C: [] as number[],
        Final: [] as number[],
      },
      completed: [] as string[],
    });
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: { event: eventName } },
      async ({ step, group, runId, attempt }) => {
        state.runId = runId;
        async function work(name: keyof typeof state.attempts, ms: number) {
          state.attempts[name].push(attempt);
          await sleep(ms);
          state.completed.push(name);
          return name;
        }

        // A -> B must advance while C is running. Discovery after B must
        // not execute C inline just because it is the only remaining step.
        await group.parallel({ mode: "race" }, () =>
          Promise.all([
            (async () => {
              await step.run("A", () => work("A", 100));
              await step.run("B", () => work("B", 100));
            })(),
            step.run("C", () => work("C", 3000)),
          ]),
        );
        await step.run("Final", () => work("Final", 0));
        return "done";
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName });
    expect(await state.waitForRunComplete()).toBe("done");
    expect(state.attempts).toEqual({ A: [0], B: [0], C: [0], Final: [0] });
    expect(state.completed).toEqual(["A", "B", "C", "Final"]);
  },
);
