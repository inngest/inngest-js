/**
 * Tests that messages fold into a state and the state draws as the expected
 * tree, with fixed times and no colour.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import type { LocalMessage, LocalStatus } from "../local/protocol.ts";
import { apply, createState, frame } from "./liveFrame.ts";

const job = (
  jobId: string,
  status: LocalStatus,
  at: number,
  extra: { parentId?: string; title?: string } = {},
): LocalMessage => {
  return { kind: "job", runId: "r", jobId, status, at, ...extra };
};

const command = (
  jobId: string,
  name: string,
  status: "running" | "failed",
  at: number,
  extra: { exitCode?: number; outputTail?: string } = {},
): LocalMessage => {
  return {
    kind: "command",
    runId: "r",
    jobId,
    commandId: name,
    name,
    attempt: 1,
    status,
    at,
    ...extra,
  };
};

const draw = (messages: LocalMessage[], now: number, concluded = false) => {
  const state = createState(0);

  state.name = "pr";
  state.url = "http://dev/run?runID=r";

  for (const message of messages) {
    apply(state, message);
  }

  if (concluded) {
    state.endedAt = now;
    state.conclusion = { status: "passed" };
  }

  return frame(state, { now, width: 80, tick: 0, color: false });
};

describe("frame", () => {
  test("before any job reports it says what is starting", () => {
    const state = createState(0);

    state.status = "Starting the Dev Server";

    expect(frame(state, { now: 0, width: 80, tick: 0, color: false })).toEqual([
      "⠋ inngest-ci",
      "  Starting the Dev Server",
    ]);
  });

  test("mid-run: jobs in a tree, matrix cells grouped, each running job's command", () => {
    const lines = draw(
      [
        job("base", "cached", 1000, { title: "Cached 14h ago" }),
        job("typecheck", "running", 1000, { parentId: "base" }),
        command("typecheck", "npm run typecheck", "running", 1000),
        job("lint", "passed", 9000, { parentId: "base" }),
        job("compat (node:22)", "running", 1000, { parentId: "base" }),
        command("compat (node:22)", "npm test", "running", 1000),
        job("compat (node:24)", "queued", 1000, { parentId: "base" }),
      ],
      13_000,
    );

    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "⠋ pr  http://dev/run?runID=r
      └─ ✓ base           Cached 14h ago        1s
         ├─ ⠋ typecheck   $ npm run typecheck  12s
         ├─ ✓ lint                              1s
         └─ ⠋ compat                           12s
            ├─ ⠋ node:22  $ npm test           12s
            └─ ○ node:24  queued"
    `);
  });

  test("a failed job shows its command and the end of its output", () => {
    const lines = draw(
      [
        job("lint", "running", 0),
        command("lint", "npm run lint", "failed", 4000, {
          exitCode: 2,
          outputTail: "a.ts:1 error\n\nb.ts:2 error",
        }),
        job("lint", "failed", 4000, { title: "`npm run lint` exited with 2" }),
      ],
      5000,
    );

    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "⠋ pr  http://dev/run?runID=r
      └─ ✕ lint    4s
          $ npm run lint exited with 2
          a.ts:1 error
          b.ts:2 error"
    `);
  });

  test("the final frame ends with a summary and no spinner", () => {
    const lines = draw(
      [
        job("base", "passed", 1000),
        job("lint", "passed", 2000, { parentId: "base" }),
      ],
      61_000,
      true,
    );

    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "pr  http://dev/run?runID=r
      └─ ✓ base       1s
         └─ ✓ lint    1s

      ✓ pr passed in 1m 1s"
    `);
  });
});
