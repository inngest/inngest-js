import { describe, expect, it } from "vitest";
import { callout } from "./callout.ts";
import { colorBar, commandsTable } from "./commands.ts";
import { mermaidGraph } from "./dag.ts";
import { chartRows, gantt } from "./gantt.ts";
import { criticalPath } from "./graph.ts";
import { link, linksRow } from "./links.ts";
import { passedJobs } from "./fixtures.ts";
import { jobTree } from "./tree.ts";

describe("callout", () => {
  it("draws a GitHub alert", () => {
    expect(callout("tip", "⚡ **41s saved**")).toBe(
      "> [!TIP]\n> ⚡ **41s saved**",
    );
  });

  it("keeps blank and list lines inside the alert", () => {
    expect(callout("note", "a\n\n- b")).toBe("> [!NOTE]\n> a\n>\n> - b");
  });
});

describe("linksRow", () => {
  it("shows every link once", () => {
    const row = linksRow("🔗", [
      link("Run", "https://x/run"),
      link("Cancel run", "https://x/run"),
      link("PR", "https://x/pr"),
      undefined,
    ]);

    expect(row).toBe("🔗 [Run](https://x/run) · [PR](https://x/pr)");
  });

  it("is empty when there is nothing to link", () => {
    expect(linksRow("🔗", [undefined])).toBe("");
  });
});

describe("commandsTable", () => {
  it("lists only commands that started or finished", () => {
    const table = commandsTable([
      { state: "done", command: "pnpm install", ms: 6000 },
      { state: "running", command: "pnpm test", ms: 72_000 },
    ]);

    expect(table).toContain("| ✅ | `pnpm install` | 6s |");
    expect(table).toContain("1m 12s so far");
    expect(table.split("\n")).toHaveLength(4);
  });

  it("says nothing when no command has started", () => {
    expect(commandsTable([])).toBe("");
  });

  it("leaves the time empty when it is not known", () => {
    expect(commandsTable([{ state: "done", command: "ls" }])).toContain(
      "| ✅ | `ls` |  |  |",
    );
  });

  it("draws a bar of at least one square", () => {
    expect(colorBar(0, "🟩", 4)).toBe("🟩⬜⬜⬜");
  });
});

describe("critical path", () => {
  it("follows the last finisher back through its last parent", () => {
    expect(criticalPath(passedJobs)).toEqual(["build", "exb", "ex"]);
  });

  it("is empty with no jobs", () => {
    expect(criticalPath([])).toEqual([]);
  });
});

describe("gantt", () => {
  const chart = gantt(passedJobs, {
    totalMs: 408_000,
    nowMs: 408_000,
    critical: ["build", "exb", "ex"],
  });

  it("marks cache hits, done jobs and the critical path", () => {
    expect(chart).toContain("cache hit, saved 4m 07s ⚡");
    expect(chart).toContain("2m 19s ✅");
    expect(chart.split("\n").filter((line) => line.endsWith("◆"))).toHaveLength(
      3,
    );
  });

  it("ends with an axis", () => {
    expect(chart.split("\n").at(-1)).toMatch(/^\s+0s\s+6m 48s$/);
  });

  it("draws queued and running jobs against now", () => {
    const live = gantt(
      [
        {
          id: "a",
          name: "a",
          parents: [],
          startMs: 0,
          state: "running",
          building: true,
        },
        { id: "b", name: "b", parents: ["a"], startMs: 0, state: "queued" },
      ],
      { totalMs: 100_000, nowMs: 50_000 },
    );

    expect(live).toContain("50s building 🔄");
    expect(live).toContain("···");
    expect(live).toContain("queued");
  });

  it("picks failures and the critical path when there are too many rows", () => {
    const many = [
      ...Array.from({ length: 30 }, (_, index) => {
        return {
          id: `j${index}`,
          name: `j${index}`,
          parents: [],
          startMs: index,
          endMs: index + 1,
          state: "ok" as const,
        };
      }),
      {
        id: "bad",
        name: "bad",
        parents: [],
        startMs: 5,
        endMs: 9,
        state: "failed" as const,
      },
    ];

    const rows = chartRows(many, [], 5);

    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.id)).toContain("bad");
  });
});

describe("mermaidGraph", () => {
  const graph = mermaidGraph(passedJobs, {
    critical: ["build", "exb", "ex"],
    nowMs: 408_000,
  });

  it("is a left to right flowchart with a node per job", () => {
    expect(graph.startsWith("flowchart LR")).toBe(true);
    expect(graph).toContain('j0["⚡ build<br/>saved 4m 07s"]:::hit');
    expect(graph).toContain('j1["✅ lint<br/>28s"]:::ok');
  });

  it("draws the critical path thick", () => {
    expect(graph).toContain("j0 ==> j5");
    expect(graph).toContain("j0 --> j1");
  });

  it("keeps job names from breaking the syntax", () => {
    const text = mermaidGraph([
      {
        id: "a b",
        name: 'say "hi" <x>',
        parents: ["missing"],
        startMs: 0,
        endMs: 1,
        state: "ok",
      },
    ]);

    expect(text).not.toContain('say "hi"');
    expect(text).not.toContain("missing");
  });
});

describe("jobTree", () => {
  it("nests each job under its parent", () => {
    expect(jobTree(passedJobs).split("\n")).toEqual([
      "build  ⚡ cache hit, saved 4m 07s",
      "├─ lint  ✅ 28s",
      "├─ audit  ✅ 2m 19s",
      "├─ packages build  ⚡ cache hit, saved 3m 32s",
      "│  └─ middleware-sentry  ✅ 2m 37s",
      "└─ examples build  ⚡ cache hit, saved 3m 41s",
      "   └─ examples (nextjs)  ✅ 6m 42s",
    ]);
  });
});
