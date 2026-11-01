/**
 * @module
 * The flows of a source's `if` that reads the run's trigger event, as
 * `waitForEvent` does: `event` is the trigger, `async` is the arriving event.
 * Covered for `step.subscribe` sources.
 * Every flow runs in all 8 cells of the matrix.
 *
 * The trigger carries the cell's key in `data.key`. The driver first sends an
 * event whose `tag` is another value, which the source must not match, then
 * one whose `tag` is the trigger's key, which it must.
 */
import { type Flow, flowScenario, sleep } from "../kit/flow.ts";

const n = (message: { data?: unknown } | undefined) => {
  return (message?.data as { n: number }).n;
};

const subscribeReadsTrigger: Flow = {
  name: "inbox-source-if-trigger",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", {
      event: h.event("a"),
      if: "async.data.tag == event.data.key",
    });

    try {
      return { matched: n(await inbox.next()) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("a", { tag: "another", n: 1 });
    await sleep(1000);
    await d.send("a", { tag: d.key, n: 2 });
  },
  expect: {
    output: { matched: 2 },
    bodies: {},
    ended: ["inbox"],
    rows: ["inbox", "inbox:close", "inbox:next"],
    ticks: { inbox: 1, "inbox:next": 1 },
    steps: 3,
  },
};

export const inboxSourceIfTrigger = flowScenario({
  id: "inbox-source-if-trigger",
  owner: "sub-21-source-if-trigger",
  flows: [subscribeReadsTrigger],
});
