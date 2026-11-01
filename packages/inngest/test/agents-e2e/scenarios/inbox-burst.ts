/**
 * @module
 * A burst of messages that arrives while the code is busy: a `for await` loop
 * runs a step for each message and then does plain work before it reads the
 * next one. Each step body runs once, and every message is read once. All 8 cells of the matrix.
 *
 * The kit loader cannot parse `await using`, so the flows close the inbox in a
 * `finally`.
 */

import type { Flow, FlowHandle } from "../kit/flow.ts";
import { flowScenario, sleep } from "../kit/flow.ts";

const source = (h: FlowHandle) => {
  return { event: h.event("msg"), if: `async.data.key == "${h.key}"` };
};

const turns = (n: number) => {
  return Array.from({ length: n }, (_, i) => {
    return `turn-${i + 1}`;
  });
};

const burstOf = (count: number): Flow => {
  return {
    name: `inbox-burst-${count}`,
    run: async (h) => {
      const inbox = h.step.subscribe("inbox", source(h));

      try {
        const got: number[] = [];

        for await (const message of inbox) {
          const n = got.length + 1;
          const data = message.data as { n: number };

          await h.step.run(`turn-${n}`, () => {
            h.ran(`turn-${n}`);

            return data.n;
          });
          got.push(data.n);

          if (got.length === count) {
            break;
          }

          await sleep(150);
        }

        // Events sent together are saved in the order they reach the executor,
        // which is not the order they were sent in.
        return {
          ns: [...got].sort((a, b) => {
            return a - b;
          }),
        };
      } finally {
        await inbox.close();
      }
    },
    drive: async (d) => {
      await d.opened("inbox");
      await d.sendAll(
        "msg",
        Array.from({ length: count }, (_, i) => {
          return { n: i + 1 };
        }),
      );
    },
    expect: {
      output: { ns: Array.from({ length: count }, (_, i) => i + 1) },
      bodies: Object.fromEntries(
        turns(count).map((id) => {
          return [id, 1];
        }),
      ),
    },
  };
};

export const inboxBurst = flowScenario({
  id: "inbox-burst",
  owner: "sub-12-agents-on-new-inbox",
  flows: [burstOf(8)],
});
