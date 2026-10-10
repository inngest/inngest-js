/**
 * Tests of the span helpers, and of the one span a snapshot is: CI hands it
 * to the SDK as the step's own, so the SDK opens no second group around the
 * snapshot's create and wait.
 *
 * @module
 */

import { describe, expect, test, vi } from "vitest";
import { snapshotMachine } from "../machine/machine.ts";
import { ciOrigin } from "./names.ts";
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
