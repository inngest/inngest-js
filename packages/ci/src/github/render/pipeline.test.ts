import { describe, expect, it } from "vitest";
import { links, passedJobs } from "./fixtures.ts";
import { type PipelineInput, pipelineCheck } from "./pipeline.ts";

const saved = [
  { name: "build", savedMs: 247_000 },
  { name: "examples build", savedMs: 221_000 },
  { name: "packages build", savedMs: 212_000 },
];

const render = (
  input: Partial<PipelineInput> & Pick<PipelineInput, "state">,
) => {
  const payload = pipelineCheck({
    ...links,
    elapsedMs: 408_000,
    jobs: passedJobs,
    ...input,
  });

  expect(payload.actions.length).toBeLessThanOrEqual(3);
  expect(`${payload.summary}${payload.text ?? ""}`).not.toMatch(/[—→←↓⇒]/);
  expect(Buffer.byteLength(payload.summary)).toBeLessThan(65_000);

  return payload;
};

describe("pipeline check", () => {
  it("passed: time saved is the hero, then the critical path and slowest jobs", () => {
    const check = render({
      state: "passed",
      saved,
      buildCount: 3,
      criticalSavedMs: 468_000,
    });

    expect(check.title).toBe(
      "✅ Passed: 7 jobs in 6m 48s · ⚡ 11m 20s saved by cache",
    );
    expect(
      check.summary.startsWith(
        "> [!TIP]\n> ⚡ **11m 20s of build time skipped by caching.** 3 of 3 builds restored.",
      ),
    ).toBe(true);
    expect(check.summary).toContain(
      "On the critical path that is **7m 48s** faster.",
    );
    expect(check.summary).toContain("| `build` | **4m 07s** |");
    expect(check.summary).toContain(
      "🧭 **Critical path:** `build`, `examples build`, `examples (nextjs)`, 6m 48s",
    );
    expect(check.summary).toContain("| 🐢 Slowest | Time | |");
    expect(check.actions).toEqual([]);
  });

  it("passed: carries the Gantt, the Mermaid graph and the tree", () => {
    const check = render({ state: "passed", saved, buildCount: 3 });

    expect(check.text).toContain("```text");
    expect(check.text).toContain("cache hit, saved 4m 07s ⚡");
    expect(check.text).toContain("```mermaid\nflowchart LR");
    expect(check.text).toContain("<summary>🌳 Job tree (7 jobs)</summary>");
  });

  it("passed without caching leads with the result, not an empty saving", () => {
    const check = render({
      state: "passed",
      jobs: passedJobs.filter((job) => job.state === "ok"),
    });

    expect(check.summary.startsWith("> [!NOTE]\n> ✅ **")).toBe(true);
    expect(check.title).not.toContain("saved");
  });

  it("can leave Mermaid out", () => {
    const check = render({ state: "passed", mermaid: false });

    expect(check.text).not.toContain("mermaid");
  });

  it("failed: failures first with one link each, and the re-run buttons", () => {
    const check = render({
      state: "failed",
      jobs: [
        ...passedJobs,
        {
          id: "i3",
          name: "integration (3/6)",
          parents: ["pkgs"],
          startMs: 6000,
          endMs: 241_000,
          state: "failed",
        },
      ],
      saved,
      failures: [
        {
          name: "middleware-sentry",
          why: "Dev Server startup timed out | 60s",
          infra: true,
          checkUrl: "https://c/1",
          stepUrl: "https://s/1",
        },
        {
          name: "integration (3/6)",
          why: "AssertionError",
          annotations: 1,
          checkUrl: "https://c/2",
        },
      ],
    });

    expect(check.title).toBe(
      "❌ 1 of 8 jobs failed: middleware-sentry, integration (3/6)",
    );
    expect(check.summary).toContain("> [!CAUTION]");
    expect(check.summary).toContain(
      "Press **Re-run all** if these look like flakes",
    );
    expect(check.summary).toContain(
      "| ⚠️ middleware-sentry | Dev Server startup timed out \\| 60s (probably infra) | [open](https://c/1) | [open](https://s/1) |",
    );
    expect(check.summary).toContain("1 annotation");
    expect(check.actions.map((a) => a.identifier)).toEqual([
      "rerun-all",
      "rerun-fresh",
    ]);
  });

  it("failed with no flakes does not suggest flakes", () => {
    const check = render({
      state: "failed",
      failures: [{ name: "x", why: "y" }],
    });

    expect(check.summary).not.toContain("flakes");
  });

  it("running: progress, live Gantt and what runs now", () => {
    const check = render({
      state: "running",
      elapsedMs: 160_000,
      jobs: [
        {
          id: "a",
          name: "a",
          parents: [],
          startMs: 0,
          endMs: 3000,
          state: "cached",
          savedMs: 247_000,
        },
        {
          id: "b",
          name: "b",
          parents: ["a"],
          startMs: 3000,
          state: "running",
          building: true,
        },
        {
          id: "c",
          name: "c",
          parents: ["a"],
          startMs: 160_000,
          state: "queued",
        },
      ],
      saved: [{ name: "a", savedMs: 247_000 }],
      running: [
        {
          name: "b",
          checkUrl: "https://c/b",
          command: "pnpm build",
          ms: 157_000,
        },
      ],
    });

    expect(check.title).toBe("🔄 Running: 1 of 3 jobs done, 0 failed");
    expect(check.summary).toContain("**2m 40s in.**");
    expect(check.summary).toContain("**33%**");
    expect(check.summary).toContain("**4m 07s saved so far**");
    expect(check.summary).toContain("1 building");
    expect(check.summary).toContain(
      "| [b](https://c/b) | `pnpm build` | 2m 37s |",
    );
    expect(check.summary).toContain("building 🔄");
    expect(check.actions.map((a) => a.identifier)).toEqual(["cancel"]);
  });

  it("cancelled: says who, that nothing failed, and offers one button", () => {
    const check = render({
      state: "cancelled",
      cancelledBy: "jpwilliams",
      cancelledAt: "09:14:14 UTC",
      elapsedMs: 134_000,
      jobs: [
        ...passedJobs.slice(0, 2),
        { id: "s", name: "s", parents: [], startMs: 6000, state: "stopped" },
        { id: "q", name: "q", parents: [], startMs: 134_000, state: "queued" },
      ],
      saved,
    });

    expect(check.title).toBe(
      "🛑 Cancelled by jpwilliams after 2m 14s: 2 passed, 2 not finished",
    );
    expect(check.summary).toContain(
      "at 09:14:14 UTC by **jpwilliams**. Nothing had failed.",
    );
    expect(check.summary).toContain(
      "✅ 2 passed · 🛑 1 stopped mid-run · ⬜ 1 never started",
    );
    expect(check.summary).toContain("stopped at");
    expect(check.actions.map((a) => a.identifier)).toEqual(["rerun-all"]);
  });

  it("stays under the summary limit with a hundred failures", () => {
    const failures = Array.from({ length: 100 }, (_, index) => {
      return {
        name: `job ${index}`,
        why: "x".repeat(200),
        checkUrl: "https://c",
      };
    });

    const check = render({ state: "failed", failures });

    expect(check.summary).toContain("… and 80 more");
  });
});
