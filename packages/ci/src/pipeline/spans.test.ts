/**
 * Tests of the span helpers, and of the one span a snapshot is: CI hands it
 * to the SDK as the step's own, so the SDK opens no second group around the
 * snapshot's create and wait.
 *
 * @module
 */

import { describe, expect, test, vi } from "vitest";
import { snapshotMachine } from "../machine/machine.ts";
import type { JobConfig } from "../types.ts";
import { ciOrigin, traceName } from "./names.ts";
import type { CiJobScope } from "./scope.ts";
import { originOption } from "./spans.ts";

describe("originOption", () => {
  test("is an extra key on the step options, and nothing else", () => {
    expect({ id: "a", name: "A", ...originOption("x") }).toEqual({
      id: "a",
      name: "A",
      "~origin": "x",
    });
  });
});

describe("a snapshot's span", () => {
  test("is the job's Save sandbox span, passed as the step's own", async () => {
    const steps: unknown[] = [];

    const scope = {
      path: "test",
      machine: Promise.resolve({
        sandbox: {
          snapshot: (options: unknown) => {
            steps.push(options);

            return Promise.resolve({ id: "snap" });
          },
        },
      }),
      run: { ci: { hooks: { activity: vi.fn() } } },
    } as unknown as CiJobScope;

    await snapshotMachine(scope);

    expect(steps).toEqual([
      expect.objectContaining({
        id: "test › snapshot",
        "~span": {
          id: "test › save",
          name: "Save sandbox",
          kind: "snapshot",
          origin: ciOrigin,
        },
      }),
    ]);
  });
});

describe("a job's span name", () => {
  const named = { id: "build", name: "Build it" } as JobConfig;

  test("is the job's name, and its id when it has none", () => {
    expect(traceName.job(named, "build")).toBe("Build it");
    expect(traceName.job({ id: "build" } as JobConfig, "build")).toBe("build");
  });

  test("keeps the name on a later direct call, with its number", () => {
    expect(traceName.job(named, "build (2)")).toBe("Build it (2)");
  });
});
