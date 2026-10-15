/**
 * @module
 * Tests for the Python runner of `step.sandbox`, with a fake sandbox API that
 * answers every command with the output a test gives it.
 */

import { z } from "zod";
import type { InngestFunction } from "../InngestFunction.ts";
import type { OneShotRunner } from "./runners.ts";
import { createScopeClient, runToEnd } from "./test-helpers.ts";
import { sdkOrigin } from "./trace.ts";

type Client = ReturnType<typeof createScopeClient>["client"];

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

describe("step.sandbox.python input and failures", () => {
  test("passes the code and input to python3 as one payload", async () => {
    const { steps } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "payload", triggers: [{ event: "runner/python" }] },
        async ({ step }) => {
          await step.sandbox.python("py", "return n", { input: { n: 1 } });
        },
      );
    });

    const [exec] = steps[1]?.opts?.input as [
      { input: [{ command: string[] }] },
    ];

    expect(exec.input[0].command[0]).toBe("python3");
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
      message: "Python exited with code 1:\nNameError: x",
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
        { id: "rejects", triggers: [{ event: "runner/python" }] },
        async ({ step }) => {
          try {
            await step.sandbox.python("py", code, { input });
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

describe("step.sandbox.python with a large payload", () => {
  test("uploads it and runs the file", async () => {
    const { ran, steps, calls } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "large", triggers: [{ event: "runner/python" }] },
        async ({ step }) => {
          await step.sandbox.python("py", "x".repeat(20_000));
        },
      );
    });
    const [exec] = steps[2]?.opts?.input as [
      { input: [{ command: string[] }] },
    ];

    expect(ran).toEqual([
      "py",
      "py:run:payload",
      "py:run",
      "py:run:result",
      "py:destroy",
    ]);
    expect(calls.uploads).toHaveLength(1);
    expect(steps.slice(1, -1).map((step) => step.displayName)).toEqual([
      "Uploading code",
      "Running code",
      "Gathering result",
    ]);
    expect(calls.uploads[0]?.path).toBe("/tmp/inngest-py.json");
    expect(JSON.parse(calls.uploads[0]?.body ?? "").code).toHaveLength(20_000);
    expect(exec.input[0].command.at(-2)).toBe("@/tmp/inngest-py.json");
  });
});

describe("schema.output", () => {
  const schema = { output: z.object({ n: z.number() }) };

  const run = (file: string) => {
    return runWith({ file }, (client, keep) => {
      return client.createFunction(
        { id: "schema", triggers: [{ event: "runner/python" }] },
        async ({ step }) => {
          keep(await step.sandbox.python("py", "return 1", { schema }));
        },
      );
    });
  };

  test("types the result by the schema", () => {
    const runner = null as unknown as OneShotRunner;

    expectTypeOf(() =>
      runner("py", "return 1", { schema }),
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
        { id: "issues", triggers: [{ event: "runner/python" }] },
        async ({ step }) => {
          try {
            await step.sandbox.python("py", "return 1", { schema });
          } catch (err) {
            error = err;

            throw err;
          }
        },
      );
    });

    expect((error as Error).message).toBe(
      "Python result didn't match schema.output:\nn: Expected number, received string",
    );
  });
});

describe("step.sandbox.python", () => {
  test.each([
    { form: "a step ID", first: "py", name: "py" },
    { form: "step options", first: { id: "py" }, name: "py" },
    {
      form: "step options with a name",
      first: { id: "py", name: "Compute the mean" },
      name: "Compute the mean",
    },
  ])("takes $form first", async ({ first, name }) => {
    const { ran, steps } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "first", triggers: [{ event: "runner/python" }] },
        async ({ step }) => {
          await step.sandbox.python(first, "return 1");
        },
      );
    });

    expect(ran).toEqual(["py", "py:run", "py:run:result", "py:destroy"]);
    expect(steps.map((step) => step.opts?.span)).toEqual(
      steps.map(() => [{ id: "py", name, kind: "python" }]),
    );
  });

  test.each(outputs)("returns $name", async ({ file, expected }) => {
    const { type, ran, steps, calls, value } = await runWith(
      { file },
      (client, keep) => {
        return client.createFunction(
          { id: "one-shot", triggers: [{ event: "runner/python" }] },
          async ({ step }) => {
            keep(await step.sandbox.python("py", "return 1"));
          },
        );
      },
    );
    const span = { id: "py", name: "py", kind: "python" };

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
        { id: "options", triggers: [{ event: "runner/python" }] },
        async ({ step }) => {
          await step.sandbox.python("py", "return 1", {
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

  test("rejects invalid input before creating the sandbox", async () => {
    const { type, ran, calls } = await runWith({}, (client) => {
      return client.createFunction(
        { id: "invalid", triggers: [{ event: "runner/python" }] },
        async ({ step }) => {
          await step.sandbox.python("py", "return d", {
            input: { d: new Date() },
          });
        },
      );
    });

    expect(type).toBe("function-rejected");
    expect(ran).toEqual([]);
    expect(calls.destroys).toBe(0);
  });

  test("destroys the sandbox when the code fails", async () => {
    const { type, ran, calls } = await runWith(
      { exitCode: 1, stderr: "boom" },
      (client) => {
        return client.createFunction(
          { id: "fails", triggers: [{ event: "runner/python" }] },
          async ({ step }) => {
            await step.sandbox.python("py", "raise Exception()");
          },
        );
      },
    );

    expect(type).toBe("function-rejected");
    expect(ran).toEqual(["py", "py:run", "py:destroy"]);
    expect(calls.destroys).toBe(1);
  });
});
