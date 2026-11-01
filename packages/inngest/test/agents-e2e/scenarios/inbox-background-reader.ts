/**
 * @module
 * The flows of `step.subscribe` for a reader that waits beside foreground
 * work, with the foreground work inside `group.parallel({ mode: "race" })`:
 * a read raced with a step, and an un-awaited `for await` reader beside steps
 * and a sleep that a message reaches. `close()` ends the reader with
 * `undefined` and the run finishes, in all 8 cells of the matrix.
 *
 * Without the group, a never-ending reader beside steps keeps the run waiting
 * with `optimizeParallelism: true`, by design: a read joins the pending set
 * like `waitForEvent`. Wrapping only the reader in the group does not help.
 *
 * The kit loader cannot parse `await using`, so the flows call `close()`
 * themselves.
 */
import { group } from "inngest";
import { type Flow, type FlowHandle, flowScenario } from "../kit/flow.ts";

const source = (h: FlowHandle) => {
  return { event: h.event("msg"), if: `async.data.key == "${h.key}"` };
};

const work = (h: FlowHandle, id: string) => {
  return h.step.run(id, async () => {
    h.ran(id);

    return `${id}-done`;
  });
};

const raceRemedy: Flow = {
  name: "race-read-with-step-in-group",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    const winner = await group.parallel({ mode: "race" }, () => {
      return Promise.race([work(h, "b"), inbox.next()]);
    });
    const unread = await inbox.close();
    const next = await work(h, "c");

    return { winner, next, unread: unread.length };
  },
  drive: async (d) => {
    await d.opened("inbox");
  },
  expect: {
    output: { winner: "b-done", next: "c-done", unread: 0 },
    bodies: { b: 1, c: 1 },
    rows: ["b", "c", "inbox", "inbox:close", "inbox:next"],
    ended: ["inbox"],
  },
};

const withGapAndMessage = (name: string): Flow => {
  return {
    name,
    run: async (h) => {
      const inbox = h.step.subscribe("inbox", source(h));
      const got: number[] = [];
      let gotOne: () => void = () => undefined;
      const first = new Promise<void>((resolve) => {
        gotOne = resolve;
      });

      const read = async () => {
        for await (const message of inbox) {
          got.push((message as { data: { n: number } }).data.n);
          gotOne();
        }

        return "ended";
      };
      const bg = read();

      // The message reaches the reader while the steps run: the steps wait for
      // the reader to have it, which only a wake from the message can cause.
      const foreground = async () => {
        await first;

        const a = await work(h, "a");

        await h.step.sleep("gap", "1s");

        const b = await work(h, "b");

        return { a, b };
      };
      const done = await group.parallel({ mode: "race" }, foreground);
      const unread = await inbox.close();

      return { ...done, got, unread: unread.length, bg: await bg };
    },
    drive: async (d) => {
      await d.opened("inbox");
      await d.send("msg", { n: 7 });
    },
    expect: {
      output: {
        a: "a-done",
        b: "b-done",
        got: [7],
        unread: 0,
        bg: "ended",
      },
      bodies: { a: 1, b: 1 },
      rows: [
        "a",
        "b",
        "gap",
        "inbox",
        "inbox:close",
        "inbox:next",
        "inbox:next:1",
      ],
      ended: ["inbox"],
    },
  };
};

export const inboxBackgroundReader = flowScenario({
  id: "inbox-background-reader",
  owner: "sub-23-background-reader-v4",
  flows: [
    raceRemedy,
    withGapAndMessage("background-reader-foreground-in-group"),
  ],
});
