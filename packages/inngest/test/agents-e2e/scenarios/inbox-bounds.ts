/**
 * @module
 * An inbox that takes in more than a run may hold ends the run with the usual
 * error, even while the run sleeps. The flows lower the Dev Server's bound for
 * their function, open an inbox, sleep, and flood the inbox from the driver.
 * Every flow runs in all 8 cells of the matrix.
 *
 * The kit's loader cannot parse `await using`, so the flows close the inbox in
 * a `finally`.
 */
import {
  type Flow,
  type FlowDriver,
  type FlowHandle,
  flowScenario,
  sleep,
} from "../kit/flow.ts";

const source = (h: FlowHandle) => {
  return { event: h.event("msg"), if: `async.data.key == "${h.key}"` };
};

const flood = async (d: FlowDriver, messages: number, payload: string) => {
  await d.reached("sleeping");

  for (let n = 1; n <= messages; n++) {
    await d.send("msg", { n, payload });
    await sleep(300);
  }
};

const sleepingRun = (h: FlowHandle) => {
  return async () => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      h.mark("sleeping");
      await h.step.sleep("nap", "30s");

      return "slept";
    } finally {
      await inbox.close();
    }
  };
};

const floodPastSteps: Flow = {
  name: "inbox-flood-steps",
  bounds: { steps: 6 },
  run: async (h) => {
    return sleepingRun(h)();
  },
  drive: async (d) => {
    await flood(d, 12, "x");
  },
  expect: {
    output: null,
    failure: "step limit of 6",
    bodies: {},
    rows: ["inbox", "nap"],
  },
};

const floodPastState: Flow = {
  name: "inbox-flood-state",
  bounds: { stateSize: 4000 },
  run: async (h) => {
    return sleepingRun(h)();
  },
  drive: async (d) => {
    await flood(d, 6, "y".repeat(1500));
  },
  expect: {
    output: null,
    failure: "state size limit of 4000",
    bodies: {},
    rows: ["inbox", "nap"],
  },
};

export const inboxBounds = flowScenario({
  id: "inbox-bounds",
  owner: "sub-09-limits-on-arrival",
  flows: [floodPastSteps, floodPastState],
});
