/**
 * Tests of what a job's check shows as the job goes: queued, running with the
 * commands that have started, then passed or failed, in a run's own words.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { report } from "../report.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";

const setup = () => {
  const api = createFakeSandboxApi();
  const reporter = consoleReporter();
  const ci = createCi(createCiTestClient(api), { github: reporter });

  return { api, ci, reporter };
};

const entries = (
  reporter: ReturnType<typeof consoleReporter>,
  name: string,
  status: string,
) => {
  return reporter.history.filter((entry) => {
    return entry.name === name && entry.status === status;
  });
};

describe("a job's check", () => {
  test("is queued, then running with each command once it starts, then passed", async () => {
    const { ci, reporter } = setup();

    const test_ = ci.job("test", async () => {
      await $`pnpm install`;
      await $`pnpm test`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test_();
      }),
      { event: prEvent },
    );

    expect(entries(reporter, "pr / test", "queued")[0]?.summary).toContain(
      "> [!NOTE]",
    );

    // The job runs in a run of its own, whose first update points there.
    const updates = entries(reporter, "pr / test", "updated").filter(
      (entry) => {
        return entry.summary?.includes("| Command |");
      },
    );

    // Only the commands that have started are listed, and none is a step count.
    expect(updates[0]?.summary).toContain("| 🔄 | `pnpm install` |");
    expect(updates[0]?.summary).not.toContain("pnpm test");
    expect(updates[1]?.summary).toContain("| ✅ | `pnpm install` |");
    expect(updates[1]?.summary).toContain("| 🔄 | `pnpm test` |");
    expect(updates[1]?.title).toBe("🔄 Running `pnpm test`");

    const passed = entries(reporter, "pr / test", "completed")[0];

    expect(passed?.title).toMatch(/^✅ Passed in /);
    expect(passed?.summary).toMatch(
      /^✅ \*\*Passed\*\* in \*\*.+\*\* · 🖥️ 4 vCPU/,
    );
    expect(passed?.summary).toContain("| ✅ | `pnpm test` |");
    expect(passed?.summary).not.toMatch(/Next:|step \d+ of \d+/);
  });

  test("keeps what the job reported below the generated summary", async () => {
    const { ci, reporter } = setup();

    const test_ = ci.job("test", async () => {
      await report.summary("coverage 87%");
      await $`pnpm test`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test_();
      }),
      { event: prEvent },
    );

    const summary = entries(reporter, "pr / test", "completed")[0]?.summary;

    expect(summary?.endsWith("coverage 87%")).toBe(true);
  });

  test("a failed test tells which, in a callout, with both re-run buttons", async () => {
    const { api, ci, reporter } = setup();

    api.script([
      {
        match: "pnpm test",
        exitCode: 1,
        stdout: [
          " FAIL  src/a.test.ts > tags the run",
          "AssertionError: expected undefined to be 'x'",
          "      Tests  2 failed | 146 passed (148)",
        ].join("\n"),
      },
    ]);

    const test_ = ci.job("test", async () => {
      await $`pnpm test`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test_();
      }),
      { event: prEvent },
    );

    const failed = entries(reporter, "pr / test", "completed")[0];

    expect(failed?.title).toMatch(/^❌ 2 tests failed: /);
    expect(failed?.summary).toContain("> [!CAUTION]");
    expect(failed?.summary).toContain(
      "**2 tests failed**, 146 passed, in `pnpm test` (exit 1).",
    );
    expect(failed?.summary).toContain("| ❌ | `pnpm test` |");
  });

  test("a failure from the platform says no command ran", async () => {
    const { api, ci, reporter } = setup();

    api.script([
      {
        match: "pnpm test",
        exitCode: 1,
        stderr: "Error: Dev Server startup timed out after 60 seconds",
      },
    ]);

    const test_ = ci.job("test", async () => {
      await $`pnpm test`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test_();
      }),
      { event: prEvent },
    );

    const failed = entries(reporter, "pr / test", "completed")[0];

    expect(failed?.summary).toContain("> [!WARNING]");
    expect(failed?.summary).toContain(
      "**Probably infrastructure, not your change.**",
    );
    expect(failed?.summary).toContain("👉 Press **Re-run job**");
  });

  test("a failure names its step, since the trace has no link to a step", async () => {
    const { api, ci, reporter } = setup();

    api.script([{ match: "pnpm test", exitCode: 1, stderr: "boom" }]);

    const test_ = ci.job("test", async () => {
      await $`pnpm test`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test_();
      }),
      { event: prEvent },
    );

    const failed = entries(reporter, "pr / test", "completed")[0];

    expect(failed?.summary).toContain(
      "[Trace, failing step `test › pnpm test`](http://localhost:8288/run?runID=",
    );
  });

  test.each([
    {
      why: "a process that was killed",
      script: { match: "pnpm test", exitCode: 137, stderr: "Killed" },
      callout: "> [!WARNING]",
      says: "**Killed, probably out of memory.**",
      command: () => {
        return $`pnpm test`;
      },
    },
    {
      why: "a process stopped by SIGTERM",
      script: { match: "pnpm test", exitCode: 143 },
      callout: "> [!CAUTION]",
      says: "**Stopped by a signal.**",
      command: () => {
        return $`pnpm test`;
      },
    },
    {
      why: "a command that passes its timeout",
      script: { match: "pnpm test", execTimesOut: true },
      callout: "> [!CAUTION]",
      says: "**Timed out.** `pnpm test` was stopped after 30s.",
      command: () => {
        return $`pnpm test`.timeout("30s");
      },
    },
  ])(
    "tells $why in its own words",
    async ({ script, callout, says, command }) => {
      const { api, ci, reporter } = setup();

      api.script([script]);

      const test_ = ci.job("test", async () => {
        await command();
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await test_();
        }),
        { event: prEvent },
      );

      const failed = entries(reporter, "pr / test", "completed")[0];

      expect(failed?.summary).toContain(callout);
      expect(failed?.summary).toContain(says);
    },
  );

  test("shows a failing command's output in the order it was written", async () => {
    const { api, ci, reporter } = setup();

    api.script([
      {
        match: "pnpm test",
        exitCode: 1,
        chunks: [
          { stream: "STDOUT", text: "starting\n" },
          { stream: "STDERR", text: "Error: first\n" },
          { stream: "STDOUT", text: "cleaning up\n" },
          { stream: "STDERR", text: "Error: second\n" },
        ],
      },
    ]);

    const test_ = ci.job("test", async () => {
      await $`pnpm test`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test_();
      }),
      { event: prEvent },
    );

    const failed = entries(reporter, "pr / test", "completed")[0];

    expect(failed?.summary).toContain(
      "- Error: first\n  cleaning up\n- Error: second",
    );
  });

  describe("annotations", () => {
    const annotated = async (
      script: Parameters<ReturnType<typeof setup>["api"]["script"]>[0][number],
      body: () => Promise<unknown>,
    ) => {
      const { api, ci, reporter } = setup();

      api.script([script]);

      const job = ci.job("check", async () => {
        await body();
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await job();
        }),
        { event: prEvent },
      );

      return entries(reporter, "pr / check", "completed")[0];
    };

    test("type errors in a failed command's output are annotated at the repository's paths", async () => {
      const completed = await annotated(
        {
          match: "tsc",
          exitCode: 2,
          stdout:
            "packages/ci/src/a.ts(311,52): error TS2345: Argument of type 'a' is not assignable.\nsrc/outside.ts(1,1): error TS1: also here",
        },
        async () => {
          await $`pnpm exec tsc --noEmit --pretty false`;
        },
      );

      expect(completed?.annotations).toEqual([
        {
          path: "packages/ci/src/a.ts",
          start_line: 311,
          end_line: 311,
          annotation_level: "failure",
          title: "tsc TS2345",
          message: "Argument of type 'a' is not assignable.",
        },
        {
          path: "src/outside.ts",
          start_line: 1,
          end_line: 1,
          annotation_level: "failure",
          title: "tsc TS1",
          message: "also here",
        },
      ]);
    });

    test("a report file the command asked for is read, even when the command fails", async () => {
      const results = JSON.stringify({
        testResults: [
          {
            name: "/work/src/a.test.ts",
            status: "failed",
            assertionResults: [
              {
                status: "failed",
                fullName: "tags the run id",
                failureMessages: [
                  "AssertionError: nope\n at /work/src/a.test.ts:42:3",
                ],
              },
            ],
          },
        ],
      });

      const completed = await annotated(
        {
          match: "vitest",
          exitCode: 1,
          writes: { "/work/test-results.json": results },
        },
        async () => {
          await $`pnpm exec vitest run --reporter=json --outputFile=test-results.json`;
        },
      );

      expect(completed?.annotations).toEqual([
        expect.objectContaining({
          path: "src/a.test.ts",
          start_line: 42,
          annotation_level: "failure",
          title: "tags the run id",
          message: "AssertionError: nope",
        }),
      ]);
    });

    test("report.results reads a file for a tool the job runs through a script", async () => {
      const lint = JSON.stringify([
        {
          filePath: "/work/src/b.ts",
          messages: [
            {
              ruleId: "no-undef",
              severity: 2,
              message: "x is not defined",
              line: 8,
            },
          ],
        },
      ]);

      const completed = await annotated(
        {
          match: "pnpm lint:ci",
          exitCode: 1,
          writes: { "/work/lint.json": lint },
        },
        async () => {
          await $`pnpm lint:ci`.nothrow();

          await report.results("eslint", "lint.json");
        },
      );

      expect(completed?.annotations).toEqual([
        expect.objectContaining({
          path: "src/b.ts",
          start_line: 8,
          title: "eslint no-undef",
        }),
      ]);
    });

    test("the job's own annotations come before what tools found at the same level", async () => {
      const completed = await annotated(
        {
          match: "tsc",
          exitCode: 2,
          stdout: "src/z.ts(1,1): error TS1: from tsc",
        },
        async () => {
          await report.annotate([
            { path: "src/own.ts", line: 5, message: "mine" },
          ]);

          await $`pnpm exec tsc --pretty false`;
        },
      );

      expect(
        completed?.annotations?.map((annotation) => annotation.path),
      ).toEqual(["src/own.ts", "src/z.ts"]);
    });

    test("a missing report adds nothing and does not fail the job", async () => {
      const completed = await annotated(
        { match: "vitest", exitCode: 0 },
        async () => {
          await $`pnpm exec vitest run --reporter=json --outputFile=nowhere.json`;
        },
      );

      expect(completed?.conclusion).toBe("success");
      expect(completed?.annotations ?? []).toEqual([]);
    });
  });
});
