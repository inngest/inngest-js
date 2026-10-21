/**
 * Tests of what the pipeline's check shows as its jobs go and when it ends:
 * how far along it is, what the cache saved, what failed, and the charts.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";

const setup = (api = createFakeSandboxApi()) => {
  const reporter = consoleReporter();
  const ci = createCi(createCiTestClient(api), { github: reporter });

  return { api, ci, reporter };
};

const pipelineEntries = (
  reporter: ReturnType<typeof consoleReporter>,
  status: string,
) => {
  return reporter.history.filter((entry) => {
    return entry.name === "pr" && entry.status === status;
  });
};

describe("the pipeline's check", () => {
  test("starts as running with no job yet, then follows each job that ends", async () => {
    const { ci, reporter } = setup();

    const jobs = ["lint", "test"].map((id) => {
      return ci.job(id, async () => {
        await $`pnpm ${id}`;
      });
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        for (const job of jobs) {
          await job();
        }
      }),
      { event: prEvent },
    );

    const [started] = pipelineEntries(reporter, "in_progress");

    expect(started?.title).toBe("🔄 Running");
    expect(started?.summary).toContain("No job has started");

    const progress = pipelineEntries(reporter, "updated");

    expect(progress.map((entry) => entry.title)).toEqual([
      "🔄 Running: 1 of 1 job done, 0 failed",
      "🔄 Running: 2 of 2 jobs done, 0 failed",
    ]);
    expect(progress[0]?.summary).toContain("**100%**");
  });

  test("passed: the result, the critical path, the slowest jobs, and the charts", async () => {
    const { ci, reporter } = setup();

    const base = ci.job({ id: "base" }, async () => {
      await $`pnpm install`;
    });

    const test_ = ci.job({ id: "test", from: base }, async () => {
      await $`pnpm test`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test_();
      }),
      { event: prEvent },
    );

    const [done] = pipelineEntries(reporter, "completed");

    expect(done?.conclusion).toBe("success");
    expect(done?.title).toMatch(/^✅ Passed: 1 job in /);
    expect(done?.summary).toContain("> [!NOTE]");
    expect(done?.summary).toMatch(/🔗 \[Trace\]\(.+\) · \[Commit `abc1234`\]/);
    expect(done?.summary).not.toMatch(/Next:/);
  });

  test("failed: failures first with the reason, and both re-run buttons", async () => {
    const { api, ci, reporter } = setup();

    api.script([
      {
        match: "pnpm test",
        exitCode: 1,
        stderr: "Error: Dev Server startup timed out after 60 seconds",
      },
    ]);

    const lint = ci.job("lint", async () => {
      await $`pnpm lint`;
    });

    const test_ = ci.job("test", async () => {
      await $`pnpm test`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await Promise.allSettled([lint(), test_()]);

        throw new NonRetriableError("a job failed");
      }),
      { event: prEvent },
    );

    const [done] = pipelineEntries(reporter, "completed");

    expect(done?.conclusion).toBe("failure");
    expect(done?.title).toBe(
      "❌ 1 of 2 jobs failed: test: Error: Dev Server startup timed out after 60 seconds (exit 1)",
    );
    expect(done?.summary).toContain("> [!CAUTION]");
    expect(done?.summary).toContain(
      "Press **Re-run failed jobs** if these look like flakes",
    );
    expect(done?.summary).toContain("| ⚠️ test |");
    expect(done?.summary).toContain("(probably infra)");
  });

  test("a pipeline that throws before any job says what it threw", async () => {
    const { ci, reporter } = setup();

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        throw new NonRetriableError("no way");
      }),
      { event: prEvent },
    );

    const [done] = pipelineEntries(reporter, "completed");

    expect(done?.title).toBe("❌ no way");
    expect(done?.summary).toContain("**The pipeline failed.** no way");
  });
});
