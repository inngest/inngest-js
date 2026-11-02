/**
 * @module
 * A read that is still waiting when its inbox closes wakes the run once, so a
 * step after `close()` runs once. The flow is the shape that ran it twice: a
 * background reader that is never sent a message, foreground work in a racing
 * `group.parallel`, then `close()` and a step that notifies. The executor
 * handled the read, reported again beside the close, and the close at the same
 * time, and the two woke the run under different job ids. The flow runs 20
 * times, in all 8 cells each, because which of the two came first is a race.
 */
import { group } from "inngest";
import { type Flow, type FlowHandle, flowScenario } from "../kit/flow.ts";

const source = (h: FlowHandle) => {
  return { event: h.event("msg"), if: `async.data.key == "${h.key}"` };
};

const closeWithAWaitingRead = (round: number): Flow => {
  return {
    name: `close-once-${String(round).padStart(2, "0")}`,
    run: async (h) => {
      const inbox = h.step.subscribe("inbox", source(h));
      const bodies: unknown[] = [];

      const reading = (async () => {
        for await (const message of inbox) {
          bodies.push(message);
        }
      })();

      await group.parallel({ mode: "race" }, async () => {
        await h.step.run("merge", () => {
          h.ran("merge");

          return "merged";
        });
        await h.step.sleep("late", "1s");
      });

      await inbox.close();
      await reading;

      await h.step.run("notify-owner", () => {
        h.ran("notify-owner");

        return "notified";
      });

      return { comments: bodies.length };
    },
    drive: async (d) => {
      await d.opened("inbox");
    },
    expect: {
      output: { comments: 0 },
      bodies: { merge: 1, "notify-owner": 1 },
      rows: [
        "inbox",
        "inbox:close",
        "inbox:next",
        "late",
        "merge",
        "notify-owner",
      ],
      ended: ["inbox"],
    },
  };
};

export const inboxCloseOnce = flowScenario({
  id: "inbox-close-once",
  owner: "sub-32-close-wakes-once",
  flows: Array.from({ length: 20 }, (_, i) => {
    return closeWithAWaitingRead(i + 1);
  }),
});
