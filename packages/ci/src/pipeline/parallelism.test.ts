/**
 * Tests that every function running a pipeline turns parallelism optimization
 * off, so the executor calls back after each step and jobs run independently.
 *
 * @module
 */

import type { InngestFunction } from "inngest";
import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { createCi } from "./createCi.ts";

const optionsOf = (
  fn: InngestFunction.Any,
): { optimizeParallelism?: boolean; id?: string } => {
  return (
    fn as unknown as { opts: { optimizeParallelism?: boolean; id?: string } }
  ).opts;
};

describe("functions that run a pipeline", () => {
  test("turn parallelism optimization off", () => {
    const ci = createCi(createCiTestClient(createFakeSandboxApi()), {
      github: consoleReporter(),
    });

    const base = ci.job(
      { id: "base", cache: { key: "v1", warm: [{ cron: "0 3 * * *" }] } },
      async () => {
        await $`pnpm install`;
      },
    );

    ci.pipeline({ id: "pr", on: { event: "test/pr" } }, async () => {
      await base();
    });

    const running = ci.functions().filter((fn) => {
      const id = optionsOf(fn).id ?? "";

      return !id.endsWith("/cleanup") && !id.endsWith("/check-rerequested");
    });

    expect(running.length).toBeGreaterThan(1);

    for (const fn of running) {
      expect([optionsOf(fn).id, optionsOf(fn).optimizeParallelism]).toEqual([
        optionsOf(fn).id,
        false,
      ]);
    }
  });
});
