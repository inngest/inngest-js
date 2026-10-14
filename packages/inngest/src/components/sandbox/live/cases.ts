/**
 * @module
 * The cases of the live sandbox runner suite: the code each runner is given,
 * and what it must produce. Pure data, so the driver can list it without
 * running anything.
 */

import { z } from "zod";

import type { RunnerLanguage } from "../runnerScripts.ts";

export interface LiveCase {
  /**
   * `oneshot` is `step.sandbox.<language>`: a sandbox of its own, destroyed
   * after. `handle` is `sandbox.<language>` on the one sandbox the suite shares.
   */
  form: "oneshot" | "handle";
  language: RunnerLanguage;
  name: string;
  code: string;
  input?: Record<string, unknown>;
  schema?: z.ZodType;

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
  },
};

const typescriptOnly: LiveCase[] = [
  {
    form: "handle",
    language: "typescript",
    name: "types and enum",
    code: `
      enum Color { Red = "red", Blue = "blue" }
      interface Point { n: number }
      const point: Point = { n: 2 };
      return { color: Color.Blue, n: point.n as number };
    `,
    expect: { color: "blue", n: 2 },
  },
];

const forLanguage = (language: RunnerLanguage): LiveCase[] => {
  const code = snippets[language];
  const handle = { form: "handle", language } as const;
  const oneshot = { form: "oneshot", language } as const;

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
