/**
 * Tests that the step catalog keeps the IDs and names the trace and replays
 * already depend on, and marks as CI's work only the steps that were marked.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { ciOrigin, stepOptions, steps } from "./names.ts";

describe("the step catalog", () => {
  test.each([
    [steps.cacheKey("test"), "test › cache:key", "Check cache"],
    [steps.cleanUpMachines(0), "pipeline › cleanup", "Clean up sandboxes"],
    [
      steps.cleanUpSnapshots(2),
      "pipeline › cleanup:snapshots (attempt 2)",
      "Clean up snapshots",
    ],
    [steps.cleanUpEndedRun(), "destroy-orphans", "Clean up sandboxes"],
    [
      steps.recordCommandFailure("test › 1", 2),
      "test › 1 › exit",
      "Exited with code 2",
    ],
    [steps.startCheck("CI"), "github › check:CI:start", "Create check: CI"],
    [
      steps.startCheck("CI / test", "test"),
      "github › check:test:start",
      "Report test: started",
    ],
    [
      steps.completeCheck("CI / test", { path: "test", conclusion: "failure" }),
      "github › check:test:complete",
      "Report test: failed",
    ],
    [
      steps.retryCheck("CI", 0, 3),
      "github › check:pipeline:retry:0",
      "Report CI: retrying (attempt 2 of 3)",
    ],
    [
      steps.failedAttempt("test", 1, 3),
      "github › check:test:attempt:1",
      "Report test: retrying (attempt 2 of 3)",
    ],
    [
      steps.resolveCacheName("test › snapshot › name-taken"),
      "test › snapshot › name-taken",
      "Resolve cache name",
    ],
    [
      steps.deleteReplacedCache("test › snapshot › replaced"),
      "test › snapshot › replaced",
      "Delete replaced cache",
    ],
    [steps.githubHelper("id", "comment"), "id", "github.comment"],
    [
      steps.recordTime("start:test", "test", "ended"),
      "start:test",
      "Record end time",
    ],
  ])("%#", (spec, id, name) => {
    expect({ id: spec.id, name: spec.name }).toEqual({ id, name });
  });

  test("marks CI's own work with its origin, and an unmarked step without", () => {
    expect(stepOptions(steps.cacheKey("test"))).toMatchObject({
      "~origin": ciOrigin,
    });
    expect(stepOptions(steps.findChangedFiles())).toEqual({
      id: "changed",
      name: "Find changed files",
    });
  });
});
