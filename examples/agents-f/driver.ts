/**
 * @module
 * Drives the example agents through the inbox and checks what happened. Run
 * against a Dev Server and a Redis (`INNGEST_EXPERIMENTAL_KV_URL`).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { boom, chat, quick } from "./agents.ts";

function check(name: string, ok: boolean, detail?: unknown) {
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}`,
    ok ? "" : JSON.stringify(detail),
  );
  if (!ok) {
    process.exitCode = 1;
  }
}

async function until<T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 40_000,
) {
  const end = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < end) {
    await sleep(500);
    value = await read();
  }

  return value;
}

const run = `${Date.now()}`;

// 1. A thread starts from its first message, and a second message reaches the
// waiting run through the doorbell.
const t1 = chat.thread(`chat-${run}`);
await t1.send("hello");
const first = await until(
  () => t1.state(),
  (s) => (s.last as { seq?: number } | undefined)?.seq === 1,
);
check(
  "first message answered",
  (first.last as { text: string } | undefined)?.text === "echo: hello",
  first,
);

await t1.send("again");
const second = await until(
  () => t1.state(),
  (s) => (s.last as { seq?: number } | undefined)?.seq === 2,
);
check(
  "second message delivered to the waiting run",
  (second.last as { text: string } | undefined)?.text === "echo: again",
  second,
);
check(
  "history carries across turns",
  (second.history as unknown[] | undefined)?.length === 8,
  second,
);

// 2. A steer sent mid-turn is folded into the running turn's next model call.
await t1.send("work");
await sleep(500);
await t1.steer("faster please");
const third = await until(
  () => t1.state(),
  (s) => (s.last as { seq?: number } | undefined)?.seq === 3,
);
check(
  "steer is folded into the running turn",
  (third.last as { text: string } | undefined)?.text === "echo: faster please",
  third,
);

// 3. stop({ when: "now" }) cancels the live run.
await t1.stop({ when: "now" });
await sleep(3000);
const state = await t1.state();
check("state() reads the thread KV scope", Boolean(state.last), state);

// 4. Messages sent while a run is busy and then ends are handed to a new run.
const t2 = quick.thread(`quick-${run}`);
await t2.send("one");
await sleep(1000);
await t2.send("two");
const handed = await until(
  () => t2.state(),
  (s) => (s.last as { seq?: number } | undefined)?.seq === 2,
  60_000,
);
check(
  "unread message handed to the next run",
  (handed.last as { text: string } | undefined)?.text === "echo: two",
  handed,
);

// 5. A failed run does not strand messages either: each run fails on one
// message, and the cleanup function starts the next run for the rest.
const t3 = boom.thread(`boom-${run}`);
await t3.send("a");
await sleep(1000);
await t3.send("b");
const seen = await until(
  () => t3.state(),
  (s) => ((s.seen as number[] | undefined)?.length ?? 0) >= 2,
  60_000,
);
check(
  "failed run hands unread messages to the next run",
  JSON.stringify(seen.seen) === "[1,2]",
  seen,
);

// 6. A stop on an idle thread is discarded, so the next run is not stopped.
const t4 = chat.thread(`idle-${run}`);
await t4.stop({ when: "nextTurn" });
await t4.send("hi");
const idle = await until(
  () => t4.state(),
  (s) => s.last !== undefined,
);
check(
  "stop on an idle thread is discarded",
  (idle.last as { text: string } | undefined)?.text === "echo: hi",
  idle,
);

process.exit(process.exitCode ?? 0);
