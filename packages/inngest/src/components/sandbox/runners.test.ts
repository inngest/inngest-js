/**
 * @module
 * Tests for the Python, TypeScript and Ruby runners on a sandbox handle and on
 * `step.sandbox`, with a fake sandbox API that answers every command with the
 * output a test gives it.
 */

import { z } from "zod";
import type { InngestFunction } from "../InngestFunction.ts";
import { createDurableSandboxFacade } from "./durable.ts";
import type { SandboxRawTool } from "./protocol.ts";
import { createSandboxRunner, type OneShotRunner } from "./runners.ts";
import { createScopeClient, runToEnd } from "./test-helpers.ts";
import { sdkOrigin } from "./trace.ts";

type Client = ReturnType<typeof createScopeClient>["client"];

const languages = [
  { language: "python", title: "Python", binary: "python3" },
  { language: "typescript", title: "TypeScript", binary: "node" },
  { language: "ruby", title: "Ruby", binary: "ruby" },
] as const;

const outputs = [
  { name: "a value", file: '{"mean":2.5}', expected: { mean: 2.5 } },
  { name: "a falsy value", file: "0", expected: 0 },
  { name: "null when it doesn't return", file: "", expected: null },
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
  test.each(outputs)("returns $name", async ({ file, expected }) => {
    const { type, ran, value } = await runWith({ file }, (client, keep) => {
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
    expect(ran).toEqual(["box", "py", "py:result", "box:destroy"]);
    expect(value).toEqual(expected);
  });

  test("names the span after the name option", async () => {
    const { steps } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "named", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          const sandbox = await step.sandbox.create("box", {
            name: "box",
            vcpu: 2,
            memoryMb: 2048,
          });

          await sandbox[language]({ id: "py", name: "Mean" }, "return 1");
        },
      );
    });

    expect(steps[1]?.opts?.span).toEqual([
      { id: "py", name: "Mean", kind: language },
    ]);
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

          await sandbox[language]({ id: "py", input: { n: 1 } }, "return n");
        },
      );
    });

    const [exec] = steps[1]?.opts?.input as [
      { input: [{ command: string[] }] },
    ];

    expect(exec.input[0].command[0]).toBe(binary);
    expect(exec.input[0].command.at(-2)).toBe(
      '{"code":"return n","input":{"n":1}}',
    );
    expect(exec.input[0].command.at(-1)).toBe("/tmp/inngest-py.result.json");
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
      name: "a result too big for a step to return",
      output: { file: "x".repeat(3_000_000) },
      code: "return 'x' * 3000000",
      input: undefined,
      message:
        "/tmp/inngest-py.result.json is 3000000 bytes, over the 2097152 bytes a step can return",
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
            await sandbox[language]({ id: "py", input }, code);
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

describe.each(languages)("sandbox.$language with tools", ({ language }) => {
  test("hands them to the command", async () => {
    const exec = {
      protocolVersion: 1,
      action: "exec",
      result: {
        stdout: "",
        stderr: "",
        encoding: "base64",
        exitCode: 0,
        output: { truncated: false },
      },
    };
    const download = {
      protocolVersion: 1,
      action: "file.download",
      result: { data: "" },
    };
    const rawTool: SandboxRawTool = vi.fn(
      async (_id, operation, _tools, finish) => {
        const result = operation.action === "exec" ? exec : download;

        return finish ? finish(result) : result;
      },
    );
    const sandbox = createDurableSandboxFacade(
      {
        kind: "inngest/sandbox",
        version: 1,
        id: "22222222-2222-4222-8222-222222222222",
        name: "box",
        status: "RUNNING",
        vpcId: "11111111-1111-4111-8111-111111111111",
        imageRef: "default",
        resources: { vcpu: 2, memoryMb: 2048 },
        createdAt: "2026-07-28T00:00:00Z",
      },
      () => {
        return rawTool;
      },
    );
    const tools = { a: async () => 1 };

    await createSandboxRunner(() => sandbox, language)(
      { id: "py", tools, toolOptions: { maxCalls: 3 } },
      "return 1",
    );

    expect(rawTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "py", name: "Running code" }),
      expect.objectContaining({ action: "exec" }),
      { tools, toolOptions: { maxCalls: 3 } },
    );
  });
});

describe.each(languages)(
  "sandbox.$language with a large payload",
  ({ language }) => {
    test("uploads it and runs the file", async () => {
      const { ran, steps, calls } = await runWith({}, (client) => {
        return client.createFunction(
          { id: "large", triggers: [{ event: "runner/code" }] },
          async ({ step }) => {
            const sandbox = await step.sandbox.create("box", {
              name: "box",
              vcpu: 2,
              memoryMb: 2048,
            });

            await sandbox[language]("py", "x".repeat(20_000));
          },
        );
      });
      const [exec] = steps[2]?.opts?.input as [
        { input: [{ command: string[] }] },
      ];

      expect(ran).toEqual(["box", "py:payload", "py", "py:result"]);
      expect(calls.uploads).toHaveLength(1);
      expect(steps.slice(1).map((step) => step.displayName)).toEqual([
        "Uploading code",
        "Running code",
        "Gathering result",
      ]);
      expect(calls.uploads[0]?.path).toBe("/tmp/inngest-py.json");
      expect(JSON.parse(calls.uploads[0]?.body ?? "").code).toHaveLength(
        20_000,
      );
      expect(exec.input[0].command.at(-2)).toBe("@/tmp/inngest-py.json");
    });
  },
);

describe.each(languages)("$language schema.output", ({ language, title }) => {
  const schema = { output: z.object({ n: z.number() }) };

  const run = (file: string) => {
    return runWith({ file }, (client, keep) => {
      return client.createFunction(
        { id: "schema", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          keep(await step.sandbox[language]({ id: "py", schema }, "return 1"));
        },
      );
    });
  };

  test("types the result by the schema", () => {
    const runner = null as unknown as OneShotRunner;

    expectTypeOf(() =>
      runner({ id: "py", schema }, "return 1"),
    ).returns.resolves.toEqualTypeOf<{ n: number }>();
    expectTypeOf(() =>
      runner<number>("py", "return 1"),
    ).returns.resolves.toEqualTypeOf<number>();
  });

  test("returns the validated result", async () => {
    const { type, value } = await run('{"n":1}');

    expect(type).toBe("function-resolved");
    expect(value).toEqual({ n: 1 });
  });

  test("fails the step with the issues, without retrying", async () => {
    const { type, ran, steps } = await run('{"n":"one"}');
    const gathering = steps[2];
    const error = gathering?.error as Error;

    expect(type).toBe("function-rejected");
    expect(ran).toEqual(["py", "py:run", "py:run:result", "py:destroy"]);
    expect(gathering?.displayName).toBe("Gathering result");
    expect(error.message).toContain("n: Expected number");
    expect(error.name).toBe("NonRetriableError");
  });

  test("names every issue in the error", async () => {
    let error: unknown;
    await runWith({ file: '{"n":"one"}' }, (client) => {
      return client.createFunction(
        { id: "issues", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          const sandbox = await step.sandbox.create("box", {
            name: "box",
            vcpu: 2,
            memoryMb: 2048,
          });

          try {
            await sandbox[language]({ id: "py", schema }, "return 1");
          } catch (err) {
            error = err;

            throw err;
          }
        },
      );
    });

    expect((error as Error).message).toBe(
      `${title} result didn't match schema.output:\nn: Expected number, received string`,
    );
  });
});

describe.each(languages)("step.sandbox.$language", ({ language }) => {
  test.each(outputs)("returns $name", async ({ file, expected }) => {
    const { type, ran, steps, calls, value } = await runWith(
      { file },
      (client, keep) => {
        return client.createFunction(
          { id: "one-shot", triggers: [{ event: "runner/code" }] },
          async ({ step }) => {
            keep(await step.sandbox[language]("py", "return 1"));
          },
        );
      },
    );
    const span = { id: "py", name: "py", kind: language };

    expect(type).toBe("function-resolved");
    expect(ran).toEqual(["py", "py:run", "py:run:result", "py:destroy"]);
    expect(steps.map((step) => step.opts?.span)).toEqual([
      [span],
      [span],
      [span],
      [span],
    ]);
    expect(steps.map((step) => step.displayName)).toEqual([
      "Creating sandbox",
      "Running code",
      "Gathering result",
      "Destroying sandbox",
    ]);
    expect(steps.map((step) => step.opts?.origin)).toEqual(
      steps.map(() => sdkOrigin),
    );
    expect(steps[2]?.data).toEqual(expected);
    expect(calls.destroys).toBe(1);
    expect(value).toEqual(expected);
  });

  test("creates the sandbox with the options it is given", async () => {
    const { steps } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "options", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          await step.sandbox[language](
            { id: "py", vcpu: 1, environment: { A: "b" } },
            "return 1",
          );
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

  test("rejects invalid input before creating the sandbox", async () => {
    const { type, ran, calls } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "invalid", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          await step.sandbox[language](
            { id: "py", input: { d: new Date() } },
            "return d",
          );
        },
      );
    });

    expect(type).toBe("function-rejected");
    expect(ran).toEqual([]);
    expect(calls.destroys).toBe(0);
  });

  test("rejects an input named tools when it has tools, before creating the sandbox", async () => {
    const { type, ran } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "tools-input", triggers: [{ event: "runner/code" }] },
        async ({ step }) => {
          await step.sandbox[language](
            { id: "py", input: { tools: 1 }, tools: { a: async () => 1 } },
            "return 1",
          );
        },
      );
    });

    expect(type).toBe("function-rejected");
    expect(ran).toEqual([]);
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
