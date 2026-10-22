import { describe, expect, it } from "vitest";
import {
  groupAfter,
  maxAnnotations,
  omittedNote,
  shapeAnnotations,
} from "./annotations.ts";
import { parseBiome } from "./biome.ts";
import { declaredReport } from "./detect.ts";
import { parseEslint } from "./eslint.ts";
import { type Found, jsonIn } from "./found.ts";
import { repoPathOf } from "./paths.ts";
import { parseTsc } from "./tsc.ts";
import { parseTestResults } from "./vitest.ts";

const found = (overrides: Partial<Found> = {}): Found => {
  return {
    tool: "biome",
    file: "src/a.ts",
    line: 1,
    level: "warning",
    rule: "lint/x",
    title: "biome lint/x",
    message: "msg",
    ...overrides,
  };
};

describe("parseTsc", () => {
  it("reads one problem to a line, with its code", () => {
    expect(
      parseTsc(
        "packages/ci/src/a.ts(311,52): error TS2345: Argument of type 'string | undefined'\n  is not assignable to parameter of type 'string'.\nsrc/b.ts(3,1): warning TS6133: unused",
      ),
    ).toEqual([
      {
        tool: "tsc",
        file: "packages/ci/src/a.ts",
        line: 311,
        level: "failure",
        rule: "TS2345",
        title: "tsc TS2345",
        message:
          "Argument of type 'string | undefined'\nis not assignable to parameter of type 'string'.",
      },
      {
        tool: "tsc",
        file: "src/b.ts",
        line: 3,
        level: "warning",
        rule: "TS6133",
        title: "tsc TS6133",
        message: "unused",
      },
    ]);
  });

  it("ignores colours and anything that is not a problem", () => {
    expect(parseTsc("\u001b[31mhello\u001b[0m\nFound 0 errors.")).toEqual([]);
  });
});

describe("parseTestResults", () => {
  const run = (assertionResults: unknown[], extra = {}) => {
    return {
      testResults: [
        {
          name: "/work/src/a.test.ts",
          status: "failed",
          assertionResults,
          ...extra,
        },
      ],
    };
  };

  it("annotates a failed test at the line its stack points to", () => {
    const [one] = parseTestResults(
      run([
        {
          status: "failed",
          fullName: "tags the run id",
          failureMessages: [
            "AssertionError: expected undefined to be 'x'\n    at /work/src/a.test.ts:42:31",
          ],
        },
      ]),
    );

    expect(one).toMatchObject({
      file: "/work/src/a.test.ts",
      line: 42,
      level: "failure",
      title: "tags the run id",
      message: "AssertionError: expected undefined to be 'x'",
    });
  });

  it("uses the location when the report has one", () => {
    const [one] = parseTestResults(
      run([
        {
          status: "failed",
          title: "t",
          location: { line: 7 },
          failureMessages: ["x"],
        },
      ]),
    );

    expect(one?.line).toBe(7);
  });

  it("calls out a snapshot mismatch", () => {
    const [one] = parseTestResults(
      run([
        {
          status: "failed",
          title: "captures error context",
          failureMessages: ["Snapshot `captures` mismatched"],
        },
      ]),
    );

    expect(one?.title).toBe("Snapshot mismatch: captures error context");
  });

  it("warns about a test that passed only after a retry", () => {
    const [one] = parseTestResults(
      run([{ status: "passed", title: "sends the event", retryCount: 2 }], {
        status: "passed",
      }),
    );

    expect(one).toMatchObject({
      level: "warning",
      title: "Flaky: sends the event",
      message: "Passed after 2 retries.",
    });
  });

  it("reports a file that failed to run at its first line", () => {
    const [one] = parseTestResults(run([], { message: "SyntaxError: bad" }));

    expect(one).toMatchObject({ line: 1, title: "Test file failed to run" });
  });

  it("finds nothing in anything else", () => {
    expect(parseTestResults("nope")).toEqual([]);
    expect(parseTestResults({ testResults: "no" })).toEqual([]);
  });
});

describe("parseEslint", () => {
  it("reads messages by severity, with the rule's docs", () => {
    const result = parseEslint([
      {
        filePath: "/work/src/a.ts",
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "unused",
            line: 4,
            endLine: 5,
          },
          { ruleId: "@x/y", severity: 1, message: "meh", line: 9 },
          { ruleId: null, severity: 2, message: "Parsing error", line: 1 },
        ],
      },
    ]);

    expect(
      result.map((item) => [item.level, item.line, item.endLine, item.title]),
    ).toEqual([
      ["failure", 4, 5, "eslint no-unused-vars"],
      ["warning", 9, undefined, "eslint @x/y"],
      ["failure", 1, undefined, "eslint"],
    ]);
    expect(result[0]?.details).toBe(
      "https://eslint.org/docs/latest/rules/no-unused-vars",
    );
    expect(result[1]?.details).toBeUndefined();
  });

  it("finds nothing in anything else", () => {
    expect(parseEslint({})).toEqual([]);
  });
});

describe("parseBiome", () => {
  it("reads the category, severity and the line of the span", () => {
    const result = parseBiome({
      diagnostics: [
        {
          category: "lint/suspicious/noExplicitAny",
          severity: "warning",
          description: "Unexpected any.",
          location: {
            path: { file: "src/a.ts" },
            span: [12, 15],
            sourceCode: "a\nb\nconst x: any",
          },
        },
        {
          category: "format",
          severity: "error",
          description: "Formatter would have printed...",
          location: { path: { file: "src/b.ts" } },
        },
      ],
    });

    expect(result[0]).toMatchObject({
      file: "src/a.ts",
      line: 3,
      level: "warning",
      rule: "lint/suspicious/noExplicitAny",
      details: "https://biomejs.dev/linter/rules/no-explicit-any",
    });
    expect(result[1]).toMatchObject({ level: "failure", line: 1 });
    expect(result[1]?.details).toBeUndefined();
  });

  it("finds nothing in anything else", () => {
    expect(parseBiome([])).toEqual([]);
  });
});

describe("jsonIn", () => {
  it("reads JSON that follows other output", () => {
    expect(jsonIn('The --json option is unstable\n{"a":1}')).toEqual({ a: 1 });
  });

  it("is undefined for text that is not JSON", () => {
    expect(jsonIn("{ nope")).toBeUndefined();
    expect(jsonIn("no braces")).toBeUndefined();
  });
});

describe("repoPathOf", () => {
  it.each([
    ["/work/src/a.ts", "/work", "src/a.ts"],
    ["src/a.ts", "/work/packages/ci", "packages/ci/src/a.ts"],
    ["../inngest/src/b.ts", "/work/packages/ci", "packages/inngest/src/b.ts"],
    ["./src/a.ts", "/work", "src/a.ts"],
    ["file:///work/src/a.ts", "/work", "src/a.ts"],
  ])("maps %s in %s", (file, cwd, expected) => {
    expect(repoPathOf(file, cwd)).toBe(expected);
  });

  it.each([
    ["/usr/lib/node/x.js", "/work"],
    ["../../../etc/passwd", "/work/a"],
    ["/work", "/work"],
  ])("drops %s, which is not in the repository", (file, cwd) => {
    expect(repoPathOf(file, cwd)).toBeUndefined();
  });
});

describe("declaredReport", () => {
  it.each([
    [
      [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--reporter=default",
        "--reporter=json",
        "--outputFile=out.json",
      ],
      { format: "vitest", file: "out.json" },
    ],
    [
      ["vitest", "--reporter", "json", "--outputFile", "o.json"],
      { format: "vitest", file: "o.json" },
    ],
    [
      ["npx", "jest", "--json", "--outputFile=r.json"],
      { format: "jest", file: "r.json" },
    ],
    [
      ["/bin/sh", "-c", "pnpm exec eslint . -f json -o lint.json"],
      { format: "eslint", file: "lint.json" },
    ],
    [["eslint", ".", "--format=json"], { format: "eslint" }],
    [["pnpm", "biome", "check", "--reporter=json"], { format: "biome" }],
  ])("reads %j", (argv, expected) => {
    expect(declaredReport(argv)).toEqual(expected);
  });

  it.each([
    [["vitest", "run"]],
    [["eslint", "."]],
    [["pnpm", "test"]],
    [["biome", "check"]],
  ])("sees nothing to read in %j", (argv) => {
    expect(declaredReport(argv)).toBeUndefined();
  });
});

describe("shapeAnnotations", () => {
  it("puts failures before warnings before notices, the job's own first", () => {
    const shaped = shapeAnnotations(
      [
        {
          path: "own.ts",
          line: 1,
          message: "own",
          annotation_level: "warning",
        },
      ],
      [
        found({ level: "notice", file: "n.ts", message: "n" }),
        found({ level: "warning", file: "w.ts", message: "w" }),
        found({ level: "failure", file: "f.ts", message: "f" }),
      ],
    );

    expect(shaped.annotations.map((annotation) => annotation.path)).toEqual([
      "f.ts",
      "own.ts",
      "w.ts",
      "n.ts",
    ]);
  });

  it("drops the same problem found twice", () => {
    const shaped = shapeAnnotations([], [found(), found()]);

    expect(shaped.annotations).toHaveLength(1);
  });

  it("makes one annotation of a rule on more than five lines", () => {
    const many = Array.from({ length: groupAfter + 9 }, (_, index) => {
      return found({ line: index + 1, message: "Unexpected any." });
    });

    const shaped = shapeAnnotations([], many);

    expect(shaped.annotations).toHaveLength(1);
    expect(shaped.annotations[0]).toMatchObject({
      start_line: 1,
      title: "13 more of lint/x",
    });
    expect(shaped.annotations[0]?.raw_details?.split("\n")).toHaveLength(13);
  });

  it("keeps a rule on five lines or fewer as it is", () => {
    const some = Array.from({ length: groupAfter }, (_, index) => {
      return found({ line: index + 1 });
    });

    expect(shapeAnnotations([], some).annotations).toHaveLength(groupAfter);
  });

  it("stops at the cap, saying what was left out and from which tool", () => {
    const many = Array.from({ length: maxAnnotations + 12 }, (_, index) => {
      return found({
        tool: index % 2 ? "tsc" : "eslint",
        file: `src/f${index}.ts`,
        rule: `r${index}`,
      });
    });

    const shaped = shapeAnnotations([], many);

    expect(shaped.annotations).toHaveLength(maxAnnotations);
    expect(shaped.omitted).toBe(12);
    expect(shaped.omittedByTool).toEqual({ eslint: 6, tsc: 6 });
    expect(omittedNote(shaped)).toBe(
      "… and 12 more annotations (6 from eslint, 6 from tsc), see the trace.",
    );
  });

  it("says nothing when nothing was left out", () => {
    expect(omittedNote(shapeAnnotations([], [found()]))).toBeUndefined();
  });
});
