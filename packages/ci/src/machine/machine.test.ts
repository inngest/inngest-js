/**
 * Tests of pausing a finished job's machine.
 *
 * @module
 */

import { describe, expect, test, vi } from "vitest";
import type { CiJobScope } from "../pipeline/scope.ts";
import { pauseMachine, pauseTimeoutMs } from "./machine.ts";

const scopeWith = (pause: () => Promise<unknown>) => {
  return {
    path: "test",
    machine: Promise.resolve({ sandbox: { pause } }),
    run: {
      warnings: [] as string[],
      ci: { reporter: { activity: vi.fn() } },
    },
  } as unknown as CiJobScope;
};

describe("pauseMachine", () => {
  test("bounds the pause so a stuck one can't hold the pipeline", async () => {
    const pause = vi.fn(async () => {
      return undefined;
    });

    await pauseMachine(scopeWith(pause));

    expect(pause).toHaveBeenCalledWith(expect.stringContaining("pause"), {
      timeout: pauseTimeoutMs,
    });

    expect(pauseTimeoutMs).toBeLessThan(60_000);
  });

  test("a pause that fails becomes a warning, not an error", async () => {
    const scope = scopeWith(async () => {
      throw new Error("did not reach PAUSED");
    });

    await pauseMachine(scope);

    expect(scope.run.warnings).toEqual([
      expect.stringContaining("did not reach PAUSED"),
    ]);
  });
});
