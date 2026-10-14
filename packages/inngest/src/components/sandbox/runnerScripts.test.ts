/**
 * @module
 * Runs the generated commands for real with the local `node` and `python3`
 * (the Python cases are skipped when there is none), so the wrappers are
 * tested by what they do rather than by their text.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildRunner,
  parseRunnerOutput,
  type RunnerLanguage,
  type RunnerPlan,
  resultSentinel,
} from "./runnerScripts.ts";

const canRun: Record<RunnerLanguage, boolean> = {
  typescript: "stripTypeScriptTypes" in nodeModule,
  python: spawnSync("python3", ["--version"]).status === 0,
};

const dir = mkdtempSync(join(tmpdir(), "runner-scripts-"));

const execute = (plan: RunnerPlan) => {
  if (plan.upload) {
    writeFileSync(plan.upload.path, plan.upload.content);
  }

  const [file, ...args] = plan.command;
  const { status, stdout, stderr } = spawnSync(file as string, args, {
    encoding: "utf8",
  });

  return { exitCode: status, stdout, stderr };
};

const run = (
  language: RunnerLanguage,
  code: string,
  input?: Record<string, unknown>,
) => {
  const plan = buildRunner({
    language,
    code,
    input,
    payloadPath: join(dir, "payload.json"),
  });
  const { exitCode, stdout, stderr } = execute(plan);

  return { exitCode, stderr, ...parseRunnerOutput(stdout, exitCode) };
};

const languages: RunnerLanguage[] = ["typescript", "python"];

describe.each(languages)("%s runner", (language) => {
  const runnable = canRun[language];
  const pick = (ts: string, python: string) => {
    return language === "typescript" ? ts : python;
  };

  const values: {
    name: string;
    code: string;
    input?: Record<string, unknown>;
    result: unknown;
    stdout?: string;
  }[] = [
    {
      name: "input keys are globals",
      code: pick("return a + b", "return a + b"),
      input: { a: 1, b: 2 },
      result: 3,
    },
    {
      name: "JSON values arrive intact",
      code: "return value",
      input: {
        value: {
          text: `it's "quoted"\n☃ \`tick\` \${x}`,
          list: [1, 2.5, null, true, [], {}],
        },
      },
      result: {
        text: `it's "quoted"\n☃ \`tick\` \${x}`,
        list: [1, 2.5, null, true, [], {}],
      },
    },
    {
      name: "a snippet with no return has no result",
      code: pick("const x = 1", "x = 1"),
      result: undefined,
    },
    {
      name: "an empty snippet has no result",
      code: "",
      result: undefined,
    },
    {
      name: "top-level await works",
      code: pick(
        "await Promise.resolve(); return 5",
        "import asyncio\nawait asyncio.sleep(0)\nreturn 5",
      ),
      result: 5,
    },
    {
      name: "an early return stops the snippet",
      code: pick(
        "if (n > 1) return 'big'; return 'small'",
        "if n > 1:\n    return 'big'\nreturn 'small'",
      ),
      input: { n: 2 },
      result: "big",
    },
    {
      name: "output without a trailing newline stays in stdout",
      code: pick(
        "process.stdout.write('hi'); return 1",
        "print('hi', end=''); return 1",
      ),
      result: 1,
      stdout: "hi",
    },
    {
      name: "output printed after the snippet returned stays in stdout",
      code: pick(
        "setTimeout(() => console.log('later'), 10); return 1",
        "print('later'); return 1",
      ),
      result: 1,
      stdout: "later\n",
    },
    {
      name: "a printed copy of the sentinel is ignored",
      code: pick(
        `console.log('${resultSentinel}{"fake":1}'); return { real: 1 }`,
        `print('${resultSentinel}{"fake":1}'); return { "real": 1 }`,
      ),
      result: { real: 1 },
      stdout: `${resultSentinel}{"fake":1}\n`,
    },
  ];

  test.skipIf(!runnable).each(values)(
    "$name",
    ({ code, input, result, stdout = "" }) => {
      const output = run(language, code, input);

      expect(output.exitCode).toBe(0);
      expect(output.result).toEqual(result);
      expect(output.stdout).toBe(stdout);
    },
  );

  const failures: { name: string; code: string; stderr: string }[] = [
    {
      name: "an error in the snippet",
      code: pick(
        "console.log('before'); throw new Error('boom')",
        "print('before'); raise ValueError('boom')",
      ),
      stderr: "boom",
    },
    {
      name: "a return value that isn't JSON",
      code: pick("return 10n", "return {1, 2}"),
      stderr: pick("BigInt", "not JSON serializable"),
    },
    {
      name: "a syntax error",
      code: pick("return (", "return ("),
      stderr: pick("SyntaxError", "SyntaxError"),
    },
  ];

  test.skipIf(!runnable).each(failures)("$name fails with no result", (c) => {
    const output = run(language, c.code);

    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toContain(c.stderr);
    expect(output.result).toBeUndefined();
    expect(output.stdout).not.toContain(resultSentinel);
  });

  test.skipIf(!runnable)("a large payload is read from its file", () => {
    const text = "x".repeat(100_000);
    const plan = buildRunner({
      language,
      code: pick("return text.length", "return len(text)"),
      input: { text },
      payloadPath: join(dir, "large.json"),
    });
    const { stdout, exitCode } = execute(plan);
    const output = parseRunnerOutput(stdout, exitCode);

    expect(plan.upload).toBeDefined();
    expect(output.result).toBe(100_000);
  });
});

test.skipIf(!canRun.typescript)("types are stripped from TypeScript", () => {
  const output = run("typescript", "const n: number = a; return n * 2", {
    a: 4,
  });

  expect(output.result).toBe(8);
});

test.skipIf(!canRun.typescript)(
  "TypeScript that needs transforming runs",
  () => {
    const output = run("typescript", "enum Dir { Up, Down } return Dir.Down");

    expect(output.result).toBe(1);
  },
);

describe("buildRunner", () => {
  test("a small payload rides in the command", () => {
    const plan = buildRunner({
      language: "python",
      code: "return a",
      input: { a: 1 },
      payloadPath: "/tmp/p.json",
    });

    expect(plan.upload).toBeUndefined();
    expect(plan.command.slice(0, 2)).toEqual(["python3", "-c"]);
    expect(JSON.parse(plan.command.at(-1) as string)).toEqual({
      code: "return a",
      input: { a: 1 },
    });
  });

  test("a large payload is uploaded and the command reads the file", () => {
    const plan = buildRunner({
      language: "typescript",
      code: "return text",
      input: { text: "x".repeat(20_000) },
      payloadPath: "/tmp/p.json",
    });

    expect(plan.command.at(-1)).toBe("@/tmp/p.json");
    expect(plan.upload?.path).toBe("/tmp/p.json");
    expect(JSON.parse(plan.upload?.content as string).code).toBe("return text");
  });

  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const rejected: {
    name: string;
    language: RunnerLanguage;
    input: Record<string, unknown>;
    message: string;
  }[] = [
    {
      name: "a name that isn't an identifier",
      language: "typescript",
      input: { "my-key": 1 },
      message: "input.my-key can't be a typescript global",
    },
    {
      name: "a TypeScript reserved word",
      language: "typescript",
      input: { class: 1 },
      message: "input.class can't be a typescript global",
    },
    {
      name: "a Python reserved word",
      language: "python",
      input: { None: 1 },
      message: "input.None can't be a python global",
    },
    {
      name: "a name the runtime depends on",
      language: "python",
      input: { __inngest_main: 1 },
      message: "input.__inngest_main can't be a python global",
    },
    {
      name: "a built-in the snippet would lose",
      language: "typescript",
      input: { process: 1 },
      message: "input.process can't be a typescript global",
    },
    {
      name: "undefined",
      language: "typescript",
      input: { a: undefined },
      message: "input.a must be a JSON value, got undefined",
    },
    {
      name: "a function",
      language: "typescript",
      input: { a: () => 1 },
      message: "input.a must be a JSON value, got function",
    },
    {
      name: "a bigint",
      language: "python",
      input: { a: 1n },
      message: "input.a must be a JSON value, got bigint",
    },
    {
      name: "NaN",
      language: "python",
      input: { a: Number.NaN },
      message: "input.a must be a JSON value, got NaN",
    },
    {
      name: "a Date",
      language: "typescript",
      input: { when: new Date() },
      message: "input.when must be a JSON value, got Date",
    },
    {
      name: "a Map nested in an array",
      language: "typescript",
      input: { list: [new Map()] },
      message: "input.list[0] must be a JSON value, got Map",
    },
    {
      name: "an empty array slot",
      language: "typescript",
      input: { list: Object.assign(new Array(3), { 0: 1, 2: 3 }) },
      message: "input.list[1] must be a JSON value, got undefined",
    },
    {
      name: "a circular reference",
      language: "python",
      input: { a: circular },
      message: "input.a.self must be a JSON value, got a circular reference",
    },
    {
      name: "a Set nested in an object",
      language: "python",
      input: { a: { b: new Set() } },
      message: "input.a.b must be a JSON value, got Set",
    },
  ];

  test.each(rejected)("rejects $name", ({ language, input, message }) => {
    expect(() => {
      return buildRunner({ language, code: "", input, payloadPath: "/p" });
    }).toThrow(message);
  });
});

describe("parseRunnerOutput", () => {
  const sentinel = `\n${resultSentinel}`;

  const cases: {
    name: string;
    stdout: string;
    exitCode?: number;
    expected: unknown;
  }[] = [
    {
      name: "no sentinel",
      stdout: "crashed\n",
      expected: { stdout: "crashed\n" },
    },
    {
      name: "a result",
      stdout: `out\n${sentinel}{"a":1}\n`,
      expected: { stdout: "out\n", result: { a: 1 } },
    },
    {
      name: "a result after output with no trailing newline",
      stdout: `out${sentinel}[1]\n`,
      expected: { stdout: "out", result: [1] },
    },
    {
      name: "an empty result",
      stdout: `${sentinel}\n`,
      expected: { stdout: "", result: undefined },
    },
    {
      name: "a falsy result",
      stdout: `${sentinel}0\n`,
      expected: { stdout: "", result: 0 },
    },
    {
      name: "a failed command has no result",
      stdout: `out${sentinel}1\n`,
      exitCode: 1,
      expected: { stdout: `out${sentinel}1\n` },
    },
    {
      name: "the last sentinel wins",
      stdout: `${sentinel}1\nmore${sentinel}2\n`,
      expected: { stdout: `${sentinel}1\nmore`, result: 2 },
    },
  ];

  test.each(cases)("$name", ({ stdout, exitCode = 0, expected }) => {
    expect(parseRunnerOutput(stdout, exitCode)).toEqual(expected);
  });
});
