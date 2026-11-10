import {
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { describe, expect, test } from "vitest";
import { createFSM, createLoop } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import { matrixCheckpointing } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// the Dev Server runs loops from the release that adds the `loop` block to
// the function config.  an older Dev Server rejects the sync, so these tests
// run only when INNGEST_TEST_LOOPS is set.
const loopsEnabled = Boolean(process.env.INNGEST_TEST_LOOPS);

type Seen = {
  kind: string;
  id?: string;
  key: string;
  version: number;
  eventName: string;
  count: number;
};

/**
 * waits until `seen` holds `length` runs and returns them.
 */
const waitForRuns = async (seen: Seen[], length: number): Promise<Seen[]> => {
  await waitFor(() => {
    expect(seen.length).toBeGreaterThanOrEqual(length);
  });

  return seen.slice(0, length);
};

describe.skipIf(!loopsEnabled)("loops", () => {
  matrixCheckpointing(
    "state is kept per key across runs",
    async (checkpointing) => {
      const client = new Inngest({
        id: randomSuffix(testFileName),
        isDev: true,
      });
      const eventName = randomSuffix("evt");
      const seen: Seen[] = [];

      const fn = createLoop(
        client,
        {
          id: "fn",
          retries: 0,
          checkpointing,
          triggers: { event: eventName },
          key: "event.data.id",
          state: { count: 0 },
        },
        async ({ event, input, state, step }) => {
          state.count += await step.run("one", () => 1);

          seen.push({
            ...input,
            eventName: event.name,
            count: state.count,
          });
        },
      );
      await createTestApp({
        client,
        functions: [fn],
        serve: createServer,
      });

      await client.send({ name: eventName, data: { id: "a" } });
      await waitForRuns(seen, 1);
      await client.send({ name: eventName, data: { id: "a" } });
      await waitForRuns(seen, 2);
      await client.send({ name: eventName, data: { id: "b" } });
      await waitForRuns(seen, 3);
      await client.send({ name: eventName, data: { id: "a" } });

      expect(await waitForRuns(seen, 4)).toEqual([
        { kind: "event", key: "a", version: 0, eventName, count: 1 },
        { kind: "event", key: "a", version: 1, eventName, count: 2 },
        { kind: "event", key: "b", version: 0, eventName, count: 1 },
        { kind: "event", key: "a", version: 2, eventName, count: 3 },
      ]);
    },
  );

  test("steps that are not checkpointed yet are saved with the LoopReturn", async () => {
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const eventName = randomSuffix("evt");
    const seen: Seen[] = [];
    let stepCalls = 0;

    const fn = createLoop(
      client,
      {
        id: "fn",
        retries: 0,
        // the buffer is larger than the number of steps, so no step is
        // checkpointed and both go in the response with the LoopReturn.
        checkpointing: {
          bufferedSteps: 10,
        },
        triggers: { event: eventName },
        key: "event.data.id",
        state: { count: 0 },
      },
      async ({ event, input, state, step }) => {
        state.count += await step.run("one", () => {
          stepCalls++;
          return 1;
        });
        state.count += await step.run("two", () => {
          stepCalls++;
          return 2;
        });

        seen.push({
          ...input,
          eventName: event.name,
          count: state.count,
        });
      },
    );
    await createTestApp({
      client,
      functions: [fn],
      serve: createServer,
    });

    await client.send({ name: eventName, data: { id: "a" } });
    await waitForRuns(seen, 1);
    await client.send({ name: eventName, data: { id: "a" } });

    expect(await waitForRuns(seen, 2)).toEqual([
      { kind: "event", key: "a", version: 0, eventName, count: 3 },
      { kind: "event", key: "a", version: 1, eventName, count: 6 },
    ]);
    expect(stepCalls).toBe(4);
  });

  matrixCheckpointing(
    "a wake starts a run with the wake id",
    async (checkpointing) => {
      const client = new Inngest({
        id: randomSuffix(testFileName),
        isDev: true,
      });
      const eventName = randomSuffix("evt");
      const seen: Seen[] = [];

      const fn = createFSM(
        client,
        {
          id: "fn",
          retries: 0,
          checkpointing,
          triggers: { event: eventName },
          key: "event.data.id",
          state: { count: 0 },
        },
        async ({ event, input, state, loop }) => {
          state.count++;
          seen.push({
            ...input,
            eventName: event.name,
            count: state.count,
          });

          if (input.kind === "event") {
            return loop.wake("soak", "1s");
          }
        },
      );
      await createTestApp({
        client,
        functions: [fn],
        serve: createServer,
      });

      await client.send({ name: eventName, data: { id: "a" } });

      expect(await waitForRuns(seen, 2)).toEqual([
        { kind: "event", key: "a", version: 0, eventName, count: 1 },
        {
          kind: "wake",
          id: "soak",
          key: "a",
          version: 1,
          eventName: "inngest/loop.wake",
          count: 2,
        },
      ]);

      // the wake run asked for no wake, and the fsm has no tick.
      await sleep(3000);
      expect(seen).toHaveLength(2);
    },
  );

  test("a tick starts runs until the instance ends", async () => {
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const eventName = randomSuffix("evt");
    const seen: Seen[] = [];

    const fn = createFSM(
      client,
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
        key: "event.data.id",
        tick: "1s",
        state: { count: 0 },
      },
      async ({ event, input, state, loop }) => {
        state.count++;
        seen.push({
          ...input,
          eventName: event.name,
          count: state.count,
        });

        if (state.count === 3) {
          return loop.end();
        }
      },
    );
    await createTestApp({
      client,
      functions: [fn],
      serve: createServer,
    });

    await client.send({ name: eventName, data: { id: "a" } });

    expect(await waitForRuns(seen, 3)).toEqual([
      { kind: "event", key: "a", version: 0, eventName, count: 1 },
      {
        kind: "tick",
        key: "a",
        version: 1,
        eventName: "inngest/loop.tick",
        count: 2,
      },
      {
        kind: "tick",
        key: "a",
        version: 2,
        eventName: "inngest/loop.tick",
        count: 3,
      },
    ]);

    // the instance ended, so no tick runs.
    await sleep(3000);
    expect(seen).toHaveLength(3);

    // a trigger after the end starts a new instance with the initial state.
    await client.send({ name: eventName, data: { id: "a" } });
    const runs = await waitForRuns(seen, 4);
    expect(runs[3]).toEqual({
      kind: "event",
      key: "a",
      version: 0,
      eventName,
      count: 1,
    });
  });

  test("a run that fails commits no state", async () => {
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const eventName = randomSuffix("evt");
    const seen: Seen[] = [];

    const fn = createLoop(
      client,
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
        key: "event.data.id",
        state: { count: 0 },
      },
      async ({ event, input, state }) => {
        state.count++;
        seen.push({
          ...input,
          eventName: event.name,
          count: state.count,
        });

        if ((event.data as { fail?: boolean }).fail) {
          throw new Error("boom");
        }
      },
    );
    await createTestApp({
      client,
      functions: [fn],
      serve: createServer,
    });

    await client.send({ name: eventName, data: { id: "a" } });
    await waitForRuns(seen, 1);
    await client.send({ name: eventName, data: { id: "a", fail: true } });
    await waitForRuns(seen, 2);
    await client.send({ name: eventName, data: { id: "a" } });

    expect(await waitForRuns(seen, 3)).toEqual([
      { kind: "event", key: "a", version: 0, eventName, count: 1 },
      { kind: "event", key: "a", version: 1, eventName, count: 2 },
      { kind: "event", key: "a", version: 1, eventName, count: 2 },
    ]);
  });

  test("step.sleep fails the run and commits no state", async () => {
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const eventName = randomSuffix("evt");
    const seen: Seen[] = [];

    const fn = createLoop(
      client,
      {
        id: "fn",
        triggers: { event: eventName },
        key: "event.data.id",
        state: { count: 0 },
      },
      async ({ event, input, state, step }) => {
        state.count++;
        seen.push({
          ...input,
          eventName: event.name,
          count: state.count,
        });

        if ((event.data as { sleep?: boolean }).sleep) {
          await (
            step as unknown as {
              sleep: (id: string, time: string) => Promise<void>;
            }
          ).sleep("wait", "1s");
        }
      },
    );
    await createTestApp({
      client,
      functions: [fn],
      serve: createServer,
    });

    await client.send({ name: eventName, data: { id: "a", sleep: true } });
    await waitForRuns(seen, 1);

    // the error has no retry, so the handler does not run again.
    await sleep(3000);
    expect(seen).toHaveLength(1);

    await client.send({ name: eventName, data: { id: "a" } });
    const runs = await waitForRuns(seen, 2);
    expect(runs[1]).toEqual({
      kind: "event",
      key: "a",
      version: 0,
      eventName,
      count: 1,
    });
  });
});
