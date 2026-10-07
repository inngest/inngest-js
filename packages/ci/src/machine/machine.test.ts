/**
 * Tests of pausing a finished job's machine.
 *
 * @module
 */

import { describe, expect, test, vi } from "vitest";
import type { CiJobScope } from "../pipeline/scope.ts";
import { pauseMachine } from "./machine.ts";
import { pauseTiming } from "./pause.ts";

const scopeWith = (pause: () => Promise<unknown>) => {
  const run = vi.fn(async (_options: unknown, fn: () => unknown) => {
    return fn();
  });

  return {
    path: "test",
    machine: Promise.resolve({ id: "sandbox-1" }),
    run: {
      warnings: [] as string[],
      pauses: new Map<string, Promise<void>>(),
      ci: {
        reporter: { activity: vi.fn() },
        client: {
          sandboxes: {
            get: async () => {
              return { status: "PAUSING", pause };
            },
          },
        },
      },
      step: { run },
    },
  } as unknown as CiJobScope;
};

describe("pauseMachine", () => {
  test("runs one CI-owned step with the pause's ID and name", async () => {
    const scope = scopeWith(async () => {
      return undefined;
    });

    pauseMachine(scope);

    await scope.run.pauses.get("test");

    expect(scope.run.step.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: "test › pause", name: "Pause sandbox" }),
      expect.any(Function),
    );
  });

  test("bounds the pause so a stuck one can't hold the pipeline", async () => {
    const pause = vi.fn(async () => {
      return undefined;
    });

    const scope = scopeWith(pause);

    pauseMachine(scope);

    await scope.run.pauses.get("test");

    expect(pause).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: pauseTiming.timeoutMs }),
    );

    expect(pauseTiming.timeoutMs).toBeLessThan(60_000);
  });

  test("a pause that fails becomes a warning, not an error", async () => {
    const scope = scopeWith(async () => {
      throw new Error("did not reach PAUSED");
    });

    pauseMachine(scope);

    await scope.run.pauses.get("test");

    expect(scope.run.warnings).toEqual([
      expect.stringContaining("did not reach PAUSED"),
    ]);
  });
});
