/**
 * Tests for the plain renderer's lines.
 *
 * @module
 */

import { describe, expect, test, vi } from "vitest";
import type { SessionEvent } from "../events.ts";
import { createPaint } from "./format.ts";
import { initialModel, reduce } from "./model.ts";
import { createPlainRenderer, plainLines } from "./plain.ts";

const paint = createPaint(false);

const lines = (events: SessionEvent[]): string[] => {
  let model = initialModel;

  return events.flatMap((event) => {
    model = reduce(model, event);

    return plainLines(event, model, paint);
  });
};

describe("plainLines", () => {
  test("prints one line per transition with durations", () => {
    expect(
      lines([
        { kind: "stage", stage: "dev-server", status: "running", at: 0 },
        {
          kind: "stage",
          stage: "dev-server",
          status: "done",
          detail: "http://x",
          at: 400,
        },
        {
          kind: "run",
          eventId: "e1",
          runId: "r",
          pipelineId: "pr",
          status: "running",
          url: "u",
          at: 500,
        },
        { kind: "job", runId: "r", jobId: "lint", status: "running", at: 600 },
        { kind: "job", runId: "r", jobId: "lint", status: "passed", at: 2600 },
      ]),
    ).toEqual([
      "stage dev-server: running",
      "stage dev-server: done · http://x (0.4s)",
      "run pr: running",
      "job lint: running",
      "job lint: passed (2.0s)",
    ]);
  });

  test("prints a failed command's output, indented and without colour codes", () => {
    const events: SessionEvent[] = [
      {
        kind: "run",
        eventId: "e1",
        runId: "r",
        pipelineId: "pr",
        status: "running",
        url: "u",
        at: 0,
      },
      {
        kind: "command",
        runId: "r",
        jobId: "test",
        commandId: "c",
        name: "pnpm test",
        attempt: 2,
        status: "failed",
        exitCode: 1,
        durationMs: 1500,
        outputTail: "\x1b[31mboom\x1b[0m\n",
        at: 1,
      },
    ];

    expect(lines(events).slice(1)).toEqual([
      "command test › pnpm test: failed · attempt 2, exit 1 (1.5s)",
      "    boom",
    ]);
  });

  test("prints setup errors and the conclusion", () => {
    expect(
      lines([
        { kind: "setup-error", message: "No config.", fix: "add it", at: 1000 },
        { kind: "done", conclusion: "setup-error", at: 3000 },
      ]),
    ).toEqual([
      "error: No config.",
      "  fix:",
      "    add it",
      "setup-error in 2.0s",
    ]);
  });

  test("names the targets, what a job is doing and how to reopen each run", () => {
    expect(
      lines([
        {
          kind: "ready",
          devServerUrl: "http://127.0.0.1:1",
          devServerDir: "/db/s1",
          repo: { fullName: "a/b", ref: "main", sha: "abc1234", dirty: false },
          at: 0,
        },
        {
          kind: "targets",
          targets: [
            { kind: "pipeline", id: "pr" },
            { kind: "job", id: "lint" },
          ],
          at: 1,
        },
        {
          kind: "run",
          eventId: "e1",
          runId: "r1",
          pipelineId: "lint",
          status: "running",
          url: "u",
          at: 2,
        },
        {
          kind: "activity",
          runId: "r1",
          jobId: "lint",
          text: "creating machine…",
          at: 3,
        },
        { kind: "done", conclusion: "passed", at: 4001 },
      ]),
    ).toEqual([
      "inngest-ci pr, lint · main @ abc1234",
      "Dev Server: http://127.0.0.1:1",
      "run lint: running",
      "job lint: creating machine…",
      "passed in 4.0s",
      "open lint: inngest-ci open r1",
    ]);
  });
});

describe("the plain renderer's output", () => {
  const capture = async (events: SessionEvent[]): Promise<string[]> => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
      text: string,
      done?: () => void,
    ) => {
      written.push(text);
      done?.();

      return true;
    }) as never);

    try {
      const renderer = createPlainRenderer();

      for (const event of events) {
        renderer.handle(event);
      }

      await renderer.close();
    } finally {
      spy.mockRestore();
    }

    return written.join("").split("\n").filter(Boolean);
  };

  test("a run that failed outside its jobs says why, and so do the job and summary", async () => {
    const reason = "Sandbox did not reach RUNNING within 120000 milliseconds";

    expect(
      await capture([
        {
          kind: "run",
          eventId: "e1",
          runId: "r",
          pipelineId: "pr",
          status: "running",
          url: "u",
          at: 0,
        },
        { kind: "job", runId: "r", jobId: "lint", status: "running", at: 1 },
        {
          kind: "run",
          eventId: "e1",
          runId: "r",
          pipelineId: "pr",
          status: "failed",
          reason,
          url: "u",
          at: 2000,
        },
        { kind: "done", conclusion: "failed", at: 2000 },
      ]),
    ).toEqual([
      "run pr: running",
      "job lint: running",
      `run pr: failed — ${reason} (2.0s)`,
      `job lint: failed — ${reason} (1.9s)`,
      `failed in 2.0s — ${reason}`,
      "open pr: inngest-ci open r",
    ]);
  });

  test("a reason that arrives after the failure is still printed", async () => {
    const lines = await capture([
      {
        kind: "run",
        eventId: "e1",
        runId: "r",
        pipelineId: "pr",
        status: "failed",
        url: "u",
        at: 0,
      },
      {
        kind: "run",
        eventId: "e1",
        runId: "r",
        pipelineId: "pr",
        status: "failed",
        reason: "why",
        url: "u",
        at: 1,
      },
    ]);

    expect(lines).toEqual([
      "run pr: failed (0.0s)",
      "run pr: failed — why (0.0s)",
    ]);
  });
});
