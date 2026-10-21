import { describe, expect, it } from "vitest";
import { links } from "./fixtures.ts";
import { type JobFailure, type JobInput, jobCheck } from "./job.ts";
import type { CommandRow } from "./commands.ts";

const commands: CommandRow[] = [
  { state: "done", command: "pnpm install --offline", ms: 6000 },
  { state: "done", command: "pnpm build", ms: 22_000 },
];

const base = {
  ...links,
  name: "middleware-sentry",
  machine: "4 vCPU, 8 GiB",
  parent: { name: "build", url: "https://github.com/o/r/runs/1" },
};

const render = (input: Partial<JobInput> & Pick<JobInput, "state">) => {
  const payload = jobCheck({ ...base, ...input });

  expect(payload.actions.length).toBeLessThanOrEqual(3);
  expect(payload.summary).not.toMatch(/[—→←↓⇒]/);
  expect(payload.summary).not.toMatch(/Next:|step \d+ of \d+/);

  return payload;
};

const failure = (overrides: Partial<JobFailure>): JobFailure => {
  return {
    errorClass: "failure",
    title: "boom",
    headline: "**boom**",
    ...overrides,
  };
};

describe("job check", () => {
  it("queued: names what it waits for and offers Cancel", () => {
    const check = render({
      state: {
        kind: "queued",
        waitingFor: {
          name: "build",
          url: "https://github.com/o/r/runs/1",
          elapsedMs: 62_000,
        },
      },
    });

    expect(check.title).toBe("⏳ Queued: waiting for `build`");
    expect(check.summary.startsWith("> [!NOTE]")).toBe(true);
    expect(check.summary).toContain("It has been running for 1m 02s.");
    expect(check.summary).toContain("Will run on **4 vCPU, 8 GiB**");
    expect(check.actions.map((a) => a.identifier)).toEqual(["cancel"]);
    expect(check.summary).not.toContain("| Command |");
  });

  it("waiting on another run's build: says it is not stuck, with an ETA", () => {
    const check = render({
      state: {
        kind: "waiting-build",
        build: "build",
        builder: {
          url: "https://app.inngest.com/runs/B",
          pullRequest: {
            number: 1814,
            url: "https://github.com/o/r/pull/1814",
          },
          commit: {
            sha: "a91c0de",
            url: "https://github.com/o/r/commit/a91c0de",
          },
          elapsedMs: 182_000,
          usualMs: 250_000,
        },
        lock: "ci-build-7f3a9c",
        missReason: "`pnpm-lock.yaml` changed",
      },
    });

    expect(check.title).toBe(
      "⏳ Waiting on another run's build of `build` (about 1m 08s left)",
    );
    expect(check.summary).toContain("> [!IMPORTANT]");
    expect(check.summary).toContain("**Not stuck.**");
    expect(check.summary).toContain("[PR #1814]");
    expect(check.summary).toContain(
      "🔒 Lock `ci-build-7f3a9c` · 🧩 Cache miss: `pnpm-lock.yaml` changed",
    );
  });

  it("waiting without an ETA does not invent one", () => {
    const check = render({
      state: {
        kind: "waiting-build",
        build: "build",
        builder: { url: "u", elapsedMs: 5000 },
      },
    });

    expect(check.title).not.toContain("left");
  });

  it("building: explains the miss and who waits", () => {
    const check = render({
      name: "build",
      elapsedMs: 62_000,
      commands: [
        { state: "done", command: "pnpm install", ms: 38_000 },
        { state: "running", command: "pnpm build", ms: 24_000 },
      ],
      state: {
        kind: "building",
        reason: "`pnpm-lock.yaml` changed since the last one.",
        waiting: 14,
        otherRuns: [
          { label: "PR #1818", url: "https://github.com/o/r/pull/1818" },
        ],
        restoreMs: 3000,
        usualMs: 250_000,
      },
    });

    expect(check.title).toBe("🧱 Building cache for `build` (1m 02s)");
    expect(check.summary).toContain("**14 jobs** here and 1 other run");
    expect(check.summary).toContain(
      "restore it in about **3s** instead of 4m 10s",
    );
    expect(check.summary).toContain("| 🔄 | `pnpm build` | 24s so far |");
  });

  it("running: leads with the saving and lists started commands only", () => {
    const check = render({
      savedMs: 41_000,
      elapsedMs: 100_000,
      commands: [
        ...commands,
        { state: "running", command: "pnpm test", ms: 72_000 },
      ],
      state: { kind: "running" },
    });

    expect(check.title).toBe("🔄 Running `pnpm test` (1m 12s)");
    expect(check.summary.startsWith("> [!TIP]")).toBe(true);
    expect(check.summary).toContain("**41s saved**");
    expect(check.summary).toContain(
      "[Watch live](https://app.inngest.com/env/dogfood/runs/RUN?step=s)",
    );
    expect(check.summary).toContain(
      "[Cancel run](https://app.inngest.com/env/dogfood/runs/RUN)",
    );
    expect(check.actions.map((a) => a.identifier)).toEqual(["cancel"]);
  });

  it("running with no saving says how long it has run", () => {
    const check = render({
      savedMs: undefined,
      elapsedMs: 5000,
      state: { kind: "running" },
    });

    expect(check.summary.startsWith("> [!NOTE]")).toBe(true);
    expect(check.title).toBe("🔄 Running");
  });

  it("cache hit: the saving is the headline", () => {
    const check = render({
      name: "build",
      savedMs: 247_000,
      state: {
        kind: "cache-hit",
        restoredMs: 3000,
        builtMs: 250_000,
        builtAgo: "2h ago",
        entry: "ci-build-7f3a9c",
        snapshot: "snap_01",
        builtBy: {
          label: "Built by run 01M5G0X4",
          url: "https://app.inngest.com/runs/X",
        },
        usedBy: 14,
      },
    });

    expect(check.title).toBe("⚡ Cache hit: 4m 07s saved");
    expect(check.summary).toContain(
      "Restored in **3s** instead of building for 4m 10s.",
    );
    expect(check.summary).toContain(
      "| 💾 Entry | `ci-build-7f3a9c`, built 2h ago |",
    );
    expect(check.summary).toContain("14 jobs in this run");
    expect(check.actions).toEqual([]);
  });

  it("passed: result, saving, then what ran", () => {
    const check = render({
      elapsedMs: 157_000,
      savedMs: 41_000,
      commands,
      state: {
        kind: "passed",
        parentAge: "2h",
        tests: { passed: 148, files: 12 },
        coverage: "87.2%",
        notice: {
          label: "Deprecation at `index.ts:18`",
          url: "https://github.com/o/r/blob/x#L18",
        },
      },
    });

    expect(check.title).toBe("✅ Passed in 2m 37s · ⚡ 41s saved by cache");
    expect(
      check.summary.startsWith("✅ **Passed** in **2m 37s** · 🖥️ 4 vCPU, 8 GiB"),
    ).toBe(true);
    expect(check.summary).toContain("(2h old)");
    expect(check.summary).toContain(
      "🧪 **148 tests passed** in 12 files · 📊 coverage **87.2%**",
    );
    expect(check.actions).toEqual([]);
  });

  it("passed with nothing to report has no tip, tests or empty table", () => {
    const check = render({ elapsedMs: 1000, state: { kind: "passed" } });

    expect(check.summary).not.toContain("[!TIP]");
    expect(check.summary).not.toContain("tests passed");
    expect(check.summary).not.toContain("| Command |");
  });

  it("failed test: opens the file first and offers both re-runs", () => {
    const check = render({
      elapsedMs: 157_000,
      savedMs: 41_000,
      commands: [
        ...commands,
        { state: "failed", command: "pnpm test", ms: 129_000 },
      ],
      state: {
        kind: "failed",
        failure: failure({
          errorClass: "test",
          title: "2 tests failed: AssertionError",
          headline: "**2 tests failed**, 146 passed, in `pnpm test` (exit 1).",
          open: [
            {
              label: "`middleware.test.ts:42`",
              url: "https://github.com/o/r/blob/x#L42",
            },
          ],
          excerpt: [
            { text: "AssertionError: expected undefined", bad: true },
            { text: "   42|     expect(x)" },
          ],
          log: "full log",
        }),
      },
    });

    expect(check.title).toBe("❌ 2 tests failed: AssertionError");
    expect(check.summary).toContain("> [!CAUTION]");
    expect(check.summary).toContain("👉 **Open** [`middleware.test.ts:42`]");
    expect(check.summary).toContain(
      "```diff\n- AssertionError: expected undefined\n     42|",
    );
    expect(check.text).toContain("<details>");
    expect(check.actions.map((a) => a.identifier)).toEqual([
      "rerun",
      "rerun-fresh",
    ]);
  });

  it("failed infra: leads with the verdict and the re-run", () => {
    const check = render({
      state: {
        kind: "failed",
        failure: failure({
          errorClass: "infra",
          title: "Dev Server startup timed out after 60 seconds (exit 1)",
          headline:
            "**Probably infrastructure, not your change.** No test ran.",
        }),
      },
    });

    expect(check.summary).toContain("> [!WARNING]");
    expect(check.summary).toContain("⚠️ **Probably infrastructure");
    expect(check.summary).toContain("👉 Press **Re-run job** · [Failing step]");
  });

  it("failed sandbox: says no command ran", () => {
    const check = render({
      commands: [],
      state: {
        kind: "failed",
        failure: failure({
          errorClass: "sandbox",
          title: "Sandbox error: 503",
          headline: "**Not your change.** No command ran.",
        }),
      },
    });

    expect(check.summary).toContain("[!WARNING]");
    expect(check.summary).not.toContain("| Command |");
  });

  it("failed code: shows tool counts", () => {
    const check = render({
      state: {
        kind: "failed",
        failure: failure({
          errorClass: "code",
          title: "TS2345",
          headline: "**2 type errors** in `tsc`",
          open: [
            { label: "`a.ts:1`", url: "https://x/a" },
            { label: "`b.ts:2`", url: "https://x/b" },
          ],
          tools: [{ tool: "tsc", errors: 2, warnings: 0, notices: 0 }],
        }),
      },
    });

    expect(check.summary).toContain(
      "**Open** [`a.ts:1`](https://x/a) · [`b.ts:2`](https://x/b)",
    );
    expect(check.summary).toContain("| `tsc` | 2 | 0 | 0 |");
  });

  it("timed out: names the command and shows the stuck step", () => {
    const check = render({
      state: {
        kind: "failed",
        failure: failure({
          errorClass: "timeout",
          title: "Timed out: `pnpm test` ran past its 15m limit",
          headline: "**Timed out.** `pnpm test` was stopped after 15m.",
        }),
      },
    });

    expect(check.title.startsWith("⏱️ Timed out")).toBe(true);
    expect(check.summary).toContain("> [!CAUTION]\n> ⏱️ **Timed out.**");
    expect(check.actions.map((a) => a.identifier)).toEqual([
      "rerun",
      "rerun-fresh",
    ]);
  });

  it("cancelled: says who, and offers one button", () => {
    const check = render({
      elapsedMs: 72_000,
      commands: [{ state: "stopped", command: "pnpm test", ms: 45_000 }],
      state: { kind: "cancelled", by: "jpwilliams", during: "pnpm test" },
    });

    expect(check.title).toBe("🛑 Cancelled by jpwilliams after 1m 12s");
    expect(check.summary).toContain("while `pnpm test` was running");
    expect(check.summary).toContain("45s when stopped");
    expect(check.actions.map((a) => a.identifier)).toEqual(["rerun"]);
  });

  it("cancelled by nobody known does not name anyone", () => {
    const check = render({ state: { kind: "cancelled" } });

    expect(check.title).toBe("🛑 Cancelled");
    expect(check.summary).not.toContain("by **");
  });

  it("skipped: lists the rule and what it compared", () => {
    const check = render({
      state: {
        kind: "skipped",
        reason: "nothing changed in `packages/x`",
        paths: ["packages/x/**", "packages/inngest/src/**"],
        changed: ["a.ts", "b.ts", "c.ts"],
      },
    });

    expect(check.title).toBe("⏭️ Skipped: nothing changed in `packages/x`");
    expect(check.summary).toContain("> - `packages/x/**`");
    expect(check.summary).toContain(
      "This change touches 3 files, none matching: `a.ts` and 2 more.",
    );
    expect(check.actions).toEqual([]);
  });

  it("fences a log that contains backticks with a longer fence", () => {
    const check = render({
      state: {
        kind: "failed",
        failure: failure({
          log: "a ``` b",
          excerpt: [{ text: "x ``` y", bad: true }],
        }),
      },
    });

    expect(check.text).toContain("````text");
    expect(check.summary).toContain("````diff");
  });
});
