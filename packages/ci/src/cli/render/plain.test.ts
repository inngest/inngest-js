/**
 * Tests for the plain renderer's lines.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import type { SessionEvent } from "../events.ts";
import { createPaint } from "./format.ts";
import { initialModel, reduce } from "./model.ts";
import { plainLines } from "./plain.ts";

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
        {
          kind: "done",
          conclusion: "setup-error",
          runUrl: "http://t",
          at: 3000,
        },
      ]),
    ).toEqual([
      "error: No config.",
      "  fix:",
      "    add it",
      "setup-error in 2.0s",
      "trace: http://t",
    ]);
  });
});
