/**
 * @module
 * The cases of the live sandbox runner suite: the code each runner is given,
 * and what it must produce. Pure data, so the driver can list it without
 * running anything.
 */

import { z } from "zod";

import type { RunnerLanguage } from "../runnerScripts.ts";
import { type SandboxToolOptions, tool } from "../tools.ts";

export interface LiveCase {
  /**
   * `oneshot` is `step.sandbox.<language>`: a sandbox of its own, destroyed
   * after. `handle` is `sandbox.<language>` on the one sandbox the suite shares.
   * `command` is `commands.run` of `code` with that language's interpreter.
   */
  form: "oneshot" | "handle" | "command";
  language: RunnerLanguage;
  name: string;
  code: string;
  input?: Record<string, unknown>;
  schema?: z.ZodType;

  /**
   * Gives the code `liveTools`, with these options.
   */
  tools?: SandboxToolOptions | true;

  /**
   * The value to get back, or a pattern the error message must match. Cases
   * that return a lot map it to a number first (`measure`).
   */
  expect: unknown;
  measure?: "length";
}

const kib = 1024;
const mib = 1024 * kib;

const total = z.object({ total: z.number() });

/**
 * What the tool cases call. Each language's snippets use the same names.
 */
export const liveTools = {
  add: (a: number, b: number) => {
    return a + b;
  },
  echo: (text: string) => {
    return text;
  },
  big: (bytes: number) => {
    return "x".repeat(bytes);
  },
  boom: () => {
    throw new Error("tool exploded");
  },
  getCustomer: tool.step({
    input: z.object({ id: z.string() }),
    run: ({ id }) => {
      return { id, name: `Customer ${id}` };
    },
  }),
};

/**
 * Returns the message of the `ToolError` that `call` raises.
 */
const tryTool = (call: string, language: RunnerLanguage): string => {
  return language === "python"
    ? `from inngest_tools import ToolError\ntry:\n    ${call}\nexcept ToolError as e:\n    return str(e)`
    : `try { ${call} } catch (e) { return e.name + ": " + e.message }`;
};

/**
 * The same snippets in each language, so that both are held to one table.
 */
const snippets: Record<
  RunnerLanguage,
  {
    small: string;
    await: string;
    total: string;
    badTotal: string;
    bigInput: string;
    bigCode: string;
    output: (bytes: number) => string;
    throws: string;
    exits: string;
    add: string;
    named: string;
    badNamed: string;
    parallel: string;
    toolThrows: string;
    bigArgs: string;
    bigResult: string;
    threeCalls: string;
    command: string;
  }
> = {
  python: {
    small: "return {'sum': a + b}",
    await: "import asyncio\nawait asyncio.sleep(0.01)\nreturn 7",
    total: "return {'total': 3}",
    badTotal: "return {'total': 'three'}",
    bigInput: "return len(blob)",
    bigCode: `pad = '${"x".repeat(20 * kib)}'\nreturn len(pad)`,
    output: (bytes) => {
      return `return 'x' * ${bytes}`;
    },
    throws: "raise ValueError('boom')",
    exits: "import sys\nsys.exit(3)",
    add: "return await tools.add(1, 2)",
    named: "return await tools.getCustomer(id='c1')",
    badNamed: tryTool("await tools.getCustomer(id=5)", "python"),
    parallel:
      "import asyncio\nreturn await asyncio.gather(*[tools.add(i, i) for i in range(5)])",
    toolThrows: tryTool("await tools.boom()", "python"),
    bigArgs: `return len(await tools.echo('x' * ${200 * kib}))`,
    bigResult: `return len(await tools.big(${900 * kib}))`,
    threeCalls: "for i in range(3):\n    await tools.add(i, i)\nreturn 'done'",
    command:
      "import asyncio\nfrom inngest_tools import tools\nprint(asyncio.run(tools.add(1, 2)))",
  },
  typescript: {
    small: "return { sum: a + b }",
    await: "await new Promise((r) => setTimeout(r, 10));\nreturn 7",
    total: "return { total: 3 }",
    badTotal: "return { total: 'three' }",
    bigInput: "return blob.length",
    bigCode: `const pad: string = '${"x".repeat(20 * kib)}';\nreturn pad.length`,
    output: (bytes) => {
      return `return 'x'.repeat(${bytes})`;
    },
    throws: "throw new Error('boom')",
    exits: "process.exit(3)",
    add: "return await tools.add(1, 2)",
    named: 'return await tools.getCustomer({ id: "c1" })',
    badNamed: tryTool("await tools.getCustomer({ id: 5 })", "typescript"),
    parallel:
      "return await Promise.all([0, 1, 2, 3, 4].map((i) => tools.add(i, i)))",
    toolThrows: tryTool("await tools.boom()", "typescript"),
    bigArgs: `return (await tools.echo('x'.repeat(${200 * kib}))).length`,
    bigResult: `return (await tools.big(${900 * kib})).length`,
    threeCalls:
      "for (let i = 0; i < 3; i++) await tools.add(i, i);\nreturn 'done'",
    command:
      'const { tools } = require("inngest_tools"); tools.add(1, 2).then(console.log)',
  },
};

const typescriptOnly: LiveCase[] = [
  {
    form: "handle",
    language: "typescript",
    name: "types",
    code: `
      interface Point { n: number }
      type Color = "red" | "blue";
      const point: Point = { n: 2 };
      const color: Color = "blue";
      return { color, n: point.n as number };
    `,
    expect: { color: "blue", n: 2 },
  },
  {
    form: "handle",
    language: "typescript",
    name: "enum gives a clear error",
    code: "enum Color { Red }\nreturn Color.Red",
    expect:
      /exited with code 1[\s\S]*parameter properties need full TypeScript/,
  },
];

const forLanguage = (language: RunnerLanguage): LiveCase[] => {
  const code = snippets[language];
  const handle = { form: "handle", language } as const;
  const oneshot = { form: "oneshot", language } as const;
  const command = { form: "command", language } as const;

  return [
    {
      ...oneshot,
      name: "small input",
      code: code.small,
      input: { a: 1, b: 2 },
      expect: { sum: 3 },
    },
    {
      ...oneshot,
      name: "schema.output fails",
      code: code.badTotal,
      schema: total,
      expect: /didn't match schema\.output[\s\S]*total/,
    },
    {
      ...oneshot,
      name: "code throws",
      code: code.throws,
      expect: /exited with code 1[\s\S]*boom/,
    },
    {
      ...handle,
      name: "small input",
      code: code.small,
      input: { a: 1, b: 2 },
      expect: { sum: 3 },
    },
    {
      ...handle,
      name: "schema.output passes",
      code: code.total,
      schema: total,
      expect: { total: 3 },
    },
    {
      ...handle,
      name: "schema.output fails",
      code: code.badTotal,
      schema: total,
      expect: /didn't match schema\.output[\s\S]*total/,
    },
    {
      ...handle,
      name: "top-level await and return",
      code: code.await,
      expect: 7,
    },
    {
      ...handle,
      name: "input over 16 KiB",
      code: code.bigInput,
      input: { blob: "x".repeat(20 * kib) },
      expect: 20 * kib,
    },
    {
      ...handle,
      name: "code over 16 KiB",
      code: code.bigCode,
      expect: 20 * kib,
    },
    {
      ...handle,
      name: "output of 1.5 MiB",
      code: code.output(1.5 * mib),
      measure: "length",
      expect: 1.5 * mib,
    },
    {
      ...handle,
      name: "output over 2 MiB",
      code: code.output(3 * mib),
      expect: /bytes a step can return/,
    },
    {
      ...handle,
      name: "code throws",
      code: code.throws,
      expect: /exited with code 1[\s\S]*boom/,
    },
    {
      ...handle,
      name: "non-zero exit",
      code: code.exits,
      expect: /exited with code 3/,
    },
    {
      ...oneshot,
      name: "tools: plain function",
      code: code.add,
      tools: true,
      expect: 3,
    },
    {
      ...handle,
      name: "tools: tool.step with named input",
      code: code.named,
      tools: true,
      expect: { id: "c1", name: "Customer c1" },
    },
    {
      ...handle,
      name: "tools: tool.step rejects a bad input",
      code: code.badNamed,
      tools: true,
      expect: /Invalid arguments for getCustomer/,
    },
    {
      ...handle,
      name: "tools: parallel calls",
      code: code.parallel,
      tools: true,
      expect: [0, 2, 4, 6, 8],
    },
    {
      ...handle,
      name: "tools: a tool that throws is a ToolError",
      code: code.toolThrows,
      tools: true,
      expect: /tool exploded/,
    },
    {
      ...handle,
      name: "tools: 200 KiB argument",
      code: code.bigArgs,
      tools: true,
      expect: 200 * kib,
    },
    {
      ...handle,
      name: "tools: 900 KiB result",
      code: code.bigResult,
      tools: true,
      expect: 900 * kib,
    },
    {
      ...handle,
      name: "tools: maxCalls exceeded",
      code: code.threeCalls,
      tools: { maxCalls: 2 },
      expect: /more than 2 tool calls/,
    },
    {
      ...command,
      name: "tools: commands.run",
      code: code.command,
      tools: true,
      expect: "3",
    },
  ];
};

export const cases: LiveCase[] = [
  ...forLanguage("python"),
  ...forLanguage("typescript"),
  ...typescriptOnly,
];

export const caseId = ({ form, language, name }: LiveCase): string => {
  return `${form}.${language}.${name}`;
};
