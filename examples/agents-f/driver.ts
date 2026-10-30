/**
 * @module
 * Drives the example agents through their threads and checks what happened.
 * Run against a Dev Server and a Redis (`INNGEST_EXPERIMENTAL_KV_URL`).
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ThreadState } from "inngest/experimental/agents";
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
  ms = 60_000,
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

/**
 * The strings of a list the agent keeps in the thread's KV.
 */
function listOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => {
    return typeof item === "string";
  });
}

/**
 * The text of the last turn the agent kept in the thread's KV.
 */
function lastText(state: ThreadState): string | undefined {
  const last = state.keys.last;
  if (typeof last !== "object" || last === null || !("text" in last)) {
    return undefined;
  }

  return typeof last.text === "string" ? last.text : undefined;
}

// 1. The first message starts the thread, and a second reaches the waiting run.
const t1 = chat.thread(`chat-${run}`);
await t1.send("hello");
const first = await until(
  () => {
    return t1.state();
  },
  (s) => {
    return lastText(s) === "echo: hello";
  },
);
check("first message answered", lastText(first) === "echo: hello", first);

await t1.send("again");
const second = await until(
  () => {
    return t1.state();
  },
  (s) => {
    return lastText(s) === "echo: again";
  },
);
check("second message answered", lastText(second) === "echo: again", second);
check(
  "history carries across turns",
  (Array.isArray(second.keys.history) ? second.keys.history.length : 0) === 8,
  second,
);

// 2. A steer sent mid-turn is folded into the running turn.
await t1.send("work");
await sleep(500);
await t1.steer("faster please");
const steered = await until(
  () => {
    return t1.state();
  },
  (s) => {
    return lastText(s) === "echo: faster please";
  },
);
check(
  "steer is folded into the running turn",
  lastText(steered) === "echo: faster please",
  steered,
);

// 3. A burst sent while a turn runs is processed exactly once each. Order is
// the order the executor handled the events in, which can differ slightly from
// the send order.
await t1.send("b0");
await sleep(300);
for (const n of [1, 2, 3, 4]) {
  await t1.send(`b${n}`);
}
const burst = await until(
  () => {
    return t1.state();
  },
  (s) => {
    return (
      listOf(s.keys.turns).filter((turn) => {
        return turn.startsWith("b");
      }).length >= 5
    );
  },
);
const turns = listOf(burst.keys.turns);
const burstTurns = turns.filter((turn) => {
  return turn.startsWith("b");
});
check(
  "burst processed exactly once each",
  JSON.stringify([...burstTurns].sort()) ===
    JSON.stringify(["b0", "b1", "b2", "b3", "b4"]),
  turns,
);

// 4. stop now cancels the live run, and a stop on the idle thread starts nothing.
await t1.stop({ when: "now" });
await sleep(3000);
await t1.stop({ when: "nextTurn" });
await sleep(3000);
const afterStop = await t1.state();
check(
  "stop on an idle thread starts no run",
  listOf(afterStop.keys.turns).length === turns.length,
  afterStop,
);

// 4b. stop now cancels a turn that is running.
const t5 = chat.thread(`stopnow-${run}`);
await t5.send("long");
await sleep(800);
await t5.stop({ when: "now" });
await sleep(6000);
const stopped = await t5.state();
check(
  "stop now cancels the running turn",
  stopped.keys.turns === undefined,
  stopped,
);

// 5. A message sent while a run finishes is handed to the next run.
const t2 = quick.thread(`quick-${run}`);
await t2.send("one");
await sleep(1000);
await t2.send("two");
const handed = await until(
  () => {
    return t2.state();
  },
  (s) => {
    return listOf(s.keys.seen).length >= 2;
  },
);
check(
  "unread message handed to the next run",
  JSON.stringify(handed.keys.seen) === JSON.stringify(["one", "two"]),
  handed,
);

// 6. A failed run does not strand messages either.
const t3 = boom.thread(`boom-${run}`);
await t3.send("a");
await sleep(1000);
await t3.send("b");
const failed = await until(
  () => {
    return t3.state();
  },
  (s) => {
    return listOf(s.keys.seen).length >= 2;
  },
);
check(
  "failed run hands unread messages to the next run",
  JSON.stringify(failed.keys.seen) === JSON.stringify(["a", "b"]),
  failed,
);

process.exit(process.exitCode ?? 0);
