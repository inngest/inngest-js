/**
 * @module
 * Tests for the Python and TypeScript runners on a sandbox handle and on `step.sandbox`, with
 * a fake sandbox API that answers every command with the output a test gives
 * it.
 */

import type { InngestFunction } from "../InngestFunction.ts";
import { createScopeClient, runToEnd } from "./test-helpers.ts";

type Client = ReturnType<typeof createScopeClient>["client"];

const languages = [
  { language: "python", title: "Python", binary: "python3" },
  { language: "typescript", title: "TypeScript", binary: "node" },
] as const;

const sentinel = "\n__INNGEST_RESULT__";

const outputs = [
  {
    name: "a value",
    stdout: `${sentinel}{"mean":2.5}\n`,
    expected: { mean: 2.5 },
  },
  {
    name: "a value after prints",
    stdout: `hello\n${sentinel}[1,2]\n`,
    expected: [1, 2],
  },
  {
    name: "nothing when it doesn't return",
    stdout: "hi\n",
    expected: undefined,
  },
];

/**
 * Run a function built on a client whose commands print `output`, and return
 * what it resolved to alongside the run.
 */
const runWith = async (
  output: Parameters<typeof createScopeClient>[1],
  define: (
    client: Client,
    keep: (value: unknown) => void,
  ) => InngestFunction.Any,
) => {
  const { client, calls } = createScopeClient(undefined, output);
  let value: unknown;
  const fn = define(client, (result) => {
    value = result;
  });
  const run = await runToEnd(fn, { attempt: 0, maxAttempts: 5 });

  return { ...run, calls, value };
};

describe.each(languages)("sandbox.$language", ({ language, title, binary }) => {
  test.each(outputs)("returns $name", async ({ stdout, expected }) => {
    const { type, ran, value } = await runWith({ stdout }, (client, keep) => {
      return client.createFunction(
        { id: "handle", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          await using sandbox = await step.sandbox.create("box", {
            name: "box",
            vcpu: 2,
            memoryMb: 2048,
          });

          keep(await sandbox[language]("py", "return 1"));
        },
      );
    });

    expect(type).toBe("function-resolved");
    expect(ran).toEqual(["box", "py", "box:destroy"]);
    expect(value).toEqual(expected);
  });

  test(`passes the code and input to ${binary} as one payload`, async () => {
    const { steps } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "payload", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          const sandbox = await step.sandbox.create("box", {
            name: "box",
            vcpu: 2,
            memoryMb: 2048,
          });

          await sandbox[language]("py", "return n", { input: { n: 1 } });
        },
      );
    });

    const [exec] = steps[1]?.opts?.input as [
      { input: [{ command: string[] }] },
    ];

    expect(exec.input[0].command[0]).toBe(binary);
    expect(exec.input[0].command.at(-1)).toBe(
      '{"code":"return n","input":{"n":1}}',
    );
  });

  test.each([
    {
      name: "a failed run",
      output: { exitCode: 1, stderr: "NameError: x" },
      code: "return x",
      input: undefined,
      message: `${title} exited with code 1:\nNameError: x`,
    },
    {
      name: "input that isn't JSON",
      output: {},
      code: "return d",
      input: { d: new Date() },
      message: "input.d must be a JSON value, got Date",
    },
    {
      name: "a payload too big for the command",
      output: {},
      code: "x".repeat(20_000),
      input: undefined,
      message: `${title} code and input must be under 16 KiB`,
    },
  ])("rejects $name", async ({ output, code, input, message }) => {
    let error: unknown;
    const { type } = await runWith(output, (client) => {
      return client.createFunction(
        { id: "rejects", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          const sandbox = await step.sandbox.create("box", {
            name: "box",
            vcpu: 2,
            memoryMb: 2048,
          });

          try {
            await sandbox[language]("py", code, { input });
          } catch (err) {
            error = err;

            throw err;
          }
        },
      );
    });

    expect(type).toBe("function-rejected");
    expect((error as Error).message).toBe(message);
  });
});

describe.each(languages)("step.sandbox.$language", ({ language, title }) => {
  test.each(outputs)("returns $name", async ({ stdout, expected }) => {
    const { type, ran, steps, calls, value } = await runWith(
      { stdout },
      (client, keep) => {
        return client.createFunction(
          { id: "one-shot", triggers: [{ event: "runner/code" }] },
          async ({ step }) => {
            keep(await step.sandbox[language]("py", "return 1"));
          },
        );
      },
    );
    const span = { id: "py", name: `${title} py`, kind: language };

    expect(type).toBe("function-resolved");
    expect(ran).toEqual(["py", "py:run", "py:destroy"]);
    expect(steps.map((step) => step.opts?.span)).toEqual([
      [span],
      [span],
      [span],
    ]);
    expect(calls.destroys).toBe(1);
    expect(value).toEqual(expected);
  });

  test("creates the sandbox with the options it is given", async () => {
    const { steps } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "options", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          await step.sandbox[language]("py", "return 1", {
            vcpu: 1,
            environment: { A: "b" },
          });
        },
      );
    });

    expect(steps[0]?.opts?.input).toMatchObject([
      {
        action: "create",
        input: [{ vcpu: 1, memoryMb: 2048, environment: { A: "b" } }],
      },
    ]);
  });

  test("destroys the sandbox when the code fails", async () => {
    const { type, ran, calls } = await runWith(
      { exitCode: 1, stderr: "boom" },
      (client) => {
        return client.createFunction(
          { id: "fails", triggers: [{ event: "runner/code" }] },
          async ({ step }) => {
            await step.sandbox[language]("py", "fail()");
          },
        );
      },
    );

    expect(type).toBe("function-rejected");
    expect(ran).toEqual(["py", "py:run", "py:destroy"]);
    expect(calls.destroys).toBe(1);
  });
});
