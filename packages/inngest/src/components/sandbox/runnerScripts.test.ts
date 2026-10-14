/**
 * @module
 * Runs the generated commands for real with the local `node` and `python3`
 * (the Python cases are skipped when there is none), so the wrappers are
 * tested by what they do rather than by their text.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildRunner,
  parseRunnerResult,
  type RunnerLanguage,
  type RunnerPlan,
} from "./runnerScripts.ts";

const canRun: Record<RunnerLanguage, boolean> = {
  typescript: "stripTypeScriptTypes" in nodeModule,
  python: spawnSync("python3", ["--version"]).status === 0,
};

const dir = mkdtempSync(join(tmpdir(), "runner-scripts-"));
let count = 0;

const execute = (
  plan: RunnerPlan,
  resultPath: string,
  env: Record<string, string> = {},
) => {
  if (plan.upload) {
    writeFileSync(plan.upload.path, plan.upload.content);
  }

  const [file, ...args] = plan.command;
  const { status, stdout, stderr } = spawnSync(file as string, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  return {
    exitCode: status,
    stdout,
    stderr,
    result: existsSync(resultPath)
      ? parseRunnerResult(readFileSync(resultPath, "utf8"))
      : undefined,
    wroteResult: existsSync(resultPath),
  };
};

const run = (
  language: RunnerLanguage,
  code: string,
  input?: Record<string, unknown>,
) => {
  const resultPath = join(dir, `result-${count++}.json`);
  const plan = buildRunner({
    language,
    code,
    input,
    payloadPath: join(dir, "payload.json"),
    resultPath,
  });

  return execute(plan, resultPath);
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
    expect(output.wroteResult).toBe(false);
  });

  test.skipIf(!runnable)("a large result doesn't touch stdout", () => {
    const output = run(
      language,
      pick("return 'x'.repeat(3_000_000)", "return 'x' * 3000000"),
    );

    expect(output.result).toHaveLength(3_000_000);
    expect(output.stdout).toBe("");
  });

  test.skipIf(!runnable)("a large payload is read from its file", () => {
    const text = "x".repeat(100_000);
    const resultPath = join(dir, "large-result.json");
    const plan = buildRunner({
      language,
      code: pick("return text.length", "return len(text)"),
      input: { text },
      payloadPath: join(dir, "large.json"),
      resultPath,
    });
    const output = execute(plan, resultPath);

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
  "TypeScript that can't be stripped is explained",
  () => {
    const output = run("typescript", "enum Color { Red } return Color.Red");

    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toContain(
      "Enums, namespaces and parameter properties need full TypeScript compilation",
    );
    expect(output.stderr).toContain("enum is not supported");
    expect(output.wroteResult).toBe(false);
  },
);

/**
 * What the engine's wrapper puts on `PYTHONPATH` and `NODE_PATH`, reduced to
 * a module whose `tools` is a marker.
 */
const stubs = join(dir, "stubs");
mkdirSync(join(stubs, "inngest_tools"), { recursive: true });
writeFileSync(join(stubs, "inngest_tools.py"), 'tools = "stub"\n');
writeFileSync(
  join(stubs, "inngest_tools", "index.js"),
  'exports.tools = "stub";\n',
);

describe.each(languages)("%s runner with tools", (language) => {
  test.skipIf(!canRun[language]).each<{
    name: string;
    env: Record<string, string>;
    result: string | undefined;
  }>([
    { name: "is a global", env: { INNGEST_TOOLS_DIR: dir }, result: "stub" },
    { name: "is not defined without them", env: {}, result: undefined },
  ])("`tools` $name", ({ env, result }) => {
    const resultPath = join(dir, `tools-${count++}.json`);
    const plan = buildRunner({
      language,
      code:
        language === "typescript"
          ? 'return typeof tools === "undefined" ? undefined : tools'
          : "return globals().get('tools')",
      payloadPath: join(dir, "tools-payload.json"),
      resultPath,
    });
    const output = execute(plan, resultPath, {
      ...env,
      PYTHONPATH: stubs,
      NODE_PATH: stubs,
    });

    expect(output.exitCode).toBe(0);
    expect(output.result).toBe(result);
  });
});

describe("buildRunner", () => {
  test("a small payload rides in the command", () => {
    const plan = buildRunner({
      language: "python",
      code: "return a",
      input: { a: 1 },
      payloadPath: "/tmp/p.json",
      resultPath: "/tmp/r.json",
    });

    expect(plan.upload).toBeUndefined();
    expect(plan.command.slice(0, 2)).toEqual(["python3", "-c"]);
    expect(plan.command.at(-1)).toBe("/tmp/r.json");
    expect(JSON.parse(plan.command.at(-2) as string)).toEqual({
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
      resultPath: "/tmp/r.json",
    });

    expect(plan.command.at(-2)).toBe("@/tmp/p.json");
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
      return buildRunner({
        language,
        code: "",
        input,
        payloadPath: "/p",
        resultPath: "/r",
      });
    }).toThrow(message);
  });
});

describe("parseRunnerResult", () => {
  test.each([
    { name: "a value", text: '{"a":1}', expected: { a: 1 } },
    { name: "a falsy value", text: "0", expected: 0 },
    { name: "an empty file", text: "", expected: undefined },
  ])("reads $name", ({ text, expected }) => {
    expect(parseRunnerResult(text)).toEqual(expected);
  });
});
