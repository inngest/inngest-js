/**
 * @module
 * Reads that settle at their message's place in the stack when they are
 * `nextBatch()` calls raced against a step, and when a background `batches()`
 * loop pushes into an array that the foreground checks after each `step.run`.
 * The foreground takes the same branch on every replay. All 8 cells of the
 * matrix. Trace rows are not asserted: whether a batch read shows a row
 * depends on the cell.
 *
 * The kit loader cannot parse `await using`, so the flows close the inbox in a
 * `finally`.
 */
import {
  type Flow,
  type FlowHandle,
  flowScenario,
  sleep,
} from "../kit/flow.ts";
import { agree, raceFlow, source } from "../kit/race.ts";

const batchMidStep = raceFlow("race-replay-batch-mid-step", {
  read: (inbox) => {
    return inbox.nextBatch();
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:start");
    await d.send("msg", { n: 1 });
  },
});

const batchAfterStep = raceFlow("race-replay-batch-after-step", {
  read: (inbox) => {
    return inbox.nextBatch();
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:end");
    await d.send("msg", { n: 1 });
  },
});

const steer = (id: string) => {
  return (h: FlowHandle) => {
    return h.step.run(id, async () => {
      h.ran(id);
      h.mark(`${id}:start`);
      await sleep(1500);
      h.mark(`${id}:end`);

      return `${id}-done`;
    });
  };
};

const steering: Flow = {
  name: "race-replay-steering",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const seen: number[] = [];

      void (async () => {
        for await (const batch of inbox.batches()) {
          for (const message of batch) {
            seen.push((message as { data: { n: number } }).data.n);
          }

          if (seen.length === 2) {
            break;
          }
        }
      })();

      await steer("a")(h);

      const afterA = seen.length;
      const recordedA = await h.step.run("record-a", () => {
        h.ran("record-a");

        return afterA;
      });

      agree(recordedA, afterA);

      await steer("b")(h);

      const afterB = seen.length;
      const recordedB = await h.step.run("record-b", () => {
        h.ran("record-b");

        return afterB;
      });

      agree(recordedA, afterA);
      agree(recordedB, afterB);

      return { consistent: true };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("a:start");
    await d.send("msg", { n: 1 });
    await d.reached("b:start");
    await d.send("msg", { n: 2 });
  },
  expect: {
    output: { consistent: true },
    bodies: { a: 1, "record-a": 1, b: 1, "record-b": 1 },
  },
};

export const inboxSteering = flowScenario({
  id: "inbox-steering",
  owner: "sub-14-race-determinism",
  flows: [batchMidStep, batchAfterStep, steering],
});
