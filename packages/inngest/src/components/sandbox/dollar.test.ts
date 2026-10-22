/**
 * @module
 * Tests for `sandbox.$`: the template rules, options, exit codes and their
 * errors (including across a replay), the managed path for long commands,
 * and the step IDs of commands that repeat or run together.
 */

import { runFnWithStack } from "../../test/helpers.ts";
import type { OutgoingOp } from "../../types.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { StepError } from "../StepError.ts";
import {
  CommandFailedError,
  CommandTimeoutError,
  commandFailure,
  getCommandError,
} from "./commandError.ts";
import {
  buildArgv,
  buildShellString,
  commandId,
  type DollarValue,
} from "./dollar.ts";
import { createClient, sandboxId, sandboxResource } from "./test-helpers.ts";
import type { DurableSandbox } from "./types.ts";

const processId = "33333333-3333-4333-8333-333333333333";

type Script = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /**
   * The exec answers with the sandbox's timeout error.
   */
  timesOut?: boolean;
  /**
   * How many wait windows pass with a process still running.
   */
  runningWaits?: number;
  /**
   * A process never exits by itself, and ends when signalled.
   */
  neverExits?: boolean;
};

type Exec = { body: Record<string, unknown> };

/**
 * A client whose commands answer from `script`, which is given the command's
 * text and the number of times that command has run. Every REST call is kept.
 */
const createFakeClient = (
  script: (text: string, count: number) => Script = (text, count) => {
    return { stdout: `${text}#${count}` };
  },
) => {
  const execs: Exec[] = [];
  const signals: unknown[] = [];
  const counts = new Map<string, number>();
  let waits = 0;
  let current: Script = {};
  let killed = false;

  const run = (command: string[]) => {
    const text = command[0] === "/bin/sh" ? command[2]! : command.join(" ");
    const count = (counts.get(text) ?? 0) + 1;

    counts.set(text, count);

    return script(text, count);
  };

  const client = createClient((path, method, { body }) => {
    if (path.endsWith("/exec")) {
      const parsed = JSON.parse(String(body)) as { command: string[] };

      execs.push({ body: parsed });
      const result = run(parsed.command);

      if (result.timesOut) {
        return Response.json(
          {
            errors: [{ code: "sandbox_exec_timed_out", message: "timed out" }],
          },
          { status: 504 },
        );
      }

      return Response.json({
        data: {
          stdout: btoa(result.stdout ?? ""),
          stderr: btoa(result.stderr ?? ""),
          encoding: "base64",
          exitCode: result.exitCode ?? 0,
        },
      });
    }

    if (path.endsWith("/processes") && method === "POST") {
      const parsed = JSON.parse(String(body)) as { command: string[] };

      execs.push({ body: parsed });
      current = run(parsed.command);
      waits = 0;
      killed = false;

      return Response.json(
        {
          data: {
            id: processId,
            command: parsed.command,
            pid: 7,
            state: "RUNNING",
            startedAt: "2026-07-28T00:00:00Z",
          },
        },
        { status: 201 },
      );
    }

    if (path.endsWith("/wait")) {
      waits++;

      if (killed) {
        return Response.json({
          data: { id: processId, state: "KILLED", terminationSignal: 15 },
        });
      }

      if (current.neverExits || waits <= (current.runningWaits ?? 0)) {
        return Response.json(
          {
            errors: [
              {
                code: "sandbox_process_wait_timed_out",
                message: "wait timed out",
              },
            ],
          },
          { status: 408 },
        );
      }

      return Response.json({
        data: {
          id: processId,
          state: "EXITED",
          exitCode: current.exitCode ?? 0,
        },
      });
    }

    if (path.endsWith("/signals")) {
      signals.push(JSON.parse(String(body)));
      killed = true;

      return new Response(null, { status: 204 });
    }

    if (path.endsWith("/output")) {
      return Response.json({
        data: {
          chunks: [
            {
              stream: "STDOUT",
              data: btoa(current.stdout ?? ""),
              encoding: "base64",
            },
            {
              stream: "STDERR",
              data: btoa(current.stderr ?? ""),
              encoding: "base64",
            },
          ],
        },
      });
    }

    if (path === "/v2/sandboxes" && method === "GET") {
      return Response.json({
        data: [sandboxResource],
        metadata: { fetchedAt: "2026-07-28T00:00:00Z" },
        page: { hasMore: false, limit: 100 },
      });
    }

    if (path === "/v2/sandboxes" && method === "POST") {
      return Response.json({ data: sandboxResource }, { status: 201 });
    }

    if (path.endsWith("/pause") || path.endsWith("/resume")) {
      return Response.json({ data: sandboxResource });
    }

    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    return undefined;
  });

  return { client, execs, signals };
};

/**
 * Run `fn` request by request, running whatever steps each request finds, and
 * return the IDs that ran in order, the steps, and how the function ended.
 */
const runAll = async (fn: InngestFunction.Any) => {
  const ran: string[] = [];
  const hashed: string[] = [];
  const steps: OutgoingOp[] = [];
  let stepState: Parameters<typeof runFnWithStack>[1] = {};

  const memoize = (step: OutgoingOp) => {
    ran.push(step.userland?.id ?? step.id);
    hashed.push(step.id);
    steps.push(step);
    stepState = {
      ...stepState,
      [step.id]: step.error
        ? { id: step.id, error: step.error }
        : { id: step.id, data: step.data },
    };
  };

  for (let request = 0; request < 80; request++) {
    const result = await runFnWithStack(fn, stepState);

    if (result.type === "step-ran") {
      memoize(result.step);
    } else if (result.type === "steps-found") {
      for (const found of result.steps) {
        const done = await runFnWithStack(fn, stepState, {
          runStep: found.id,
        });

        if (done.type === "step-ran") {
          memoize(done.step);
        }
      }
    } else {
      return { ran, hashed, steps, result };
    }
  }

  throw new Error("The function did not finish");
};

const groupFunction = (
  client: ReturnType<typeof createFakeClient>["client"],
  callback: (sandbox: DurableSandbox) => Promise<unknown>,
) => {
  return client.createFunction(
    { id: "dollar", triggers: [{ event: "dollar/run" }] },
    async ({ group }) => {
      return group.sandbox("box", callback);
    },
  );
};

const argv = (
  strings: TemplateStringsArray,
  ...values: DollarValue[]
): string[] => {
  return buildArgv(strings, values);
};

const shell = (
  strings: TemplateStringsArray,
  ...values: DollarValue[]
): string => {
  return buildShellString(strings, values);
};

describe("templates", () => {
  test("static text splits on whitespace and each value is one argument", () => {
    expect(argv`pnpm --filter ${"a b"} test`).toEqual([
      "pnpm",
      "--filter",
      "a b",
      "test",
    ]);
  });

  test("a value touching static text joins onto it", () => {
    expect(argv`git commit --message=${"fix it"}`).toEqual([
      "git",
      "commit",
      "--message=fix it",
    ]);
  });

  test("arrays spread, and false, null and undefined are dropped", () => {
    expect(
      argv`pnpm test ${["--bail", "1"]} ${false} ${null} ${undefined} ${0}`,
    ).toEqual(["pnpm", "test", "--bail", "1", "0"]);
  });

  test("$.sh quotes each value, and spreads and drops like argv", () => {
    expect(shell`grep ${"it's"} ${["a b", "c"]} ${false} | wc -l`).toBe(
      "grep 'it'\\''s' 'a b' 'c'  | wc -l",
    );
  });

  test("the default step ID is the command, cut to 60 characters", () => {
    expect(commandId("npm test")).toBe("npm test");
    expect(commandId("x".repeat(80))).toHaveLength(60);
    expect(commandId("x".repeat(80)).endsWith("…")).toBe(true);
  });
});

describe("options", () => {
  test("a command runs argv, $.sh runs a script, and both take options", async () => {
    const { client, execs } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      await sandbox.$`pnpm test ${"a b"}`;
      await sandbox.$.sh`echo ${"it's"} | cat`;

      return sandbox.$({ cwd: "/work", env: { A: "1" } })`pwd`;
    });

    const { result } = await runAll(fn);

    expect(result.type).toBe("function-resolved");
    expect(execs.map((exec) => exec.body.command)).toEqual([
      ["pnpm", "test", "a b"],
      ["/bin/sh", "-c", "echo 'it'\\''s' | cat"],
      ["pwd"],
    ]);
    expect(execs[2]?.body).toMatchObject({
      cwd: "/work",
      environment: { A: "1" },
    });
  });

  test("options merge, and env merges key by key", async () => {
    const { client, execs } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      const repo$ = sandbox.$({
        cwd: "/work/repo",
        env: { NODE_ENV: "test", A: "1" },
      });

      await repo$`one`;
      await repo$({ env: { A: "2", B: "3" } })`two`;
      await repo$({ cwd: "/other" })`three`;
    });

    await runAll(fn);

    expect(execs.map((exec) => exec.body)).toMatchObject([
      { cwd: "/work/repo", environment: { NODE_ENV: "test", A: "1" } },
      { cwd: "/work/repo", environment: { NODE_ENV: "test", A: "2", B: "3" } },
      { cwd: "/other", environment: { NODE_ENV: "test", A: "1" } },
    ]);
  });

  test("the timeout defaults to five minutes", async () => {
    const { client, execs } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      await sandbox.$`one`;
      await sandbox.$({ timeout: "10s" })`two`;
    });

    await runAll(fn);

    expect(execs.map((exec) => exec.body.timeout)).toEqual([
      "300000ms",
      "10000ms",
    ]);
  });

  test("results have text, lines and json", async () => {
    const { client } = createFakeClient((text) => {
      return { stdout: text === "json" ? '{"a":1}\n' : "a\nb\n" };
    });
    const fn = groupFunction(client, async (sandbox) => {
      const result = await sandbox.$`lines`;

      return {
        text: await sandbox.$`text`.text(),
        lines: await sandbox.$`lines`.lines(),
        json: await sandbox.$`json`.json<{ a: number }>(),
        exitCode: result.exitCode,
        stdout: result.stdout,
      };
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: {
        text: "a\nb",
        lines: ["a", "b"],
        json: { a: 1 },
        exitCode: 0,
        stdout: "a\nb\n",
      },
    });
  });

  test("the env is redacted from the recorded input, and still reaches the command", async () => {
    const { client, execs } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      await sandbox.$({ env: { TOKEN: "hunter2" } })`deploy`;
    });

    const { steps } = await runAll(fn);
    const command = steps.find((step) => step.userland?.id === "deploy");

    expect(JSON.stringify(command?.opts?.input)).not.toContain("hunter2");
    expect(command?.opts?.input).toMatchObject([
      { input: [{ environment: { TOKEN: "[redacted]" } }] },
    ]);
    expect(execs[0]?.body).toMatchObject({ environment: { TOKEN: "hunter2" } });
  });
});

describe("exit codes", () => {
  test("an allowed exit returns as data", async () => {
    const { client } = createFakeClient(() => {
      return { exitCode: 1, stdout: "found" };
    });
    const fn = groupFunction(client, async (sandbox) => {
      const listed = await sandbox.$({ exitCodes: [0, 1] })`grep -q TODO`;
      const any = await sandbox.$({ exitCodes: "any" })`flaky`;

      return [listed.exitCode, any.exitCode];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: [1, 1] });
  });

  test("a disallowed exit fails the step without retries, and the handler sees a CommandFailedError", async () => {
    const { client } = createFakeClient(() => {
      return { exitCode: 2, stdout: "out", stderr: "boom" };
    });
    const fn = groupFunction(client, async (sandbox) => {
      try {
        await sandbox.$`npm test`;
      } catch (error) {
        const command = getCommandError(error);

        return {
          step: error instanceof StepError,
          name: command?.name,
          command: command?.command,
          exitCode: command instanceof CommandFailedError && command.exitCode,
          stdoutTail: command?.stdoutTail,
          stderrTail: command?.stderrTail,
        };
      }

      throw new Error("The command did not fail");
    });

    const { result, steps } = await runAll(fn);
    const failed = steps.find((step) => step.userland?.id === "npm test");

    // The failure is the step's own, and is final
    expect(failed?.error).toMatchObject({ name: "NonRetriableError" });
    expect(result).toMatchObject({
      data: {
        step: true,
        name: "CommandFailedError",
        command: "npm test",
        exitCode: 2,
        stdoutTail: "out",
        stderrTail: "boom",
      },
    });
  });

  test("a failure left uncaught fails the function, and replays as the same error", async () => {
    const { client } = createFakeClient(() => {
      return { exitCode: 1 };
    });
    const fn = groupFunction(client, async (sandbox) => {
      await sandbox.$`false`;
    });

    const { result, ran } = await runAll(fn);

    expect(result.type).toBe("function-rejected");
    expect(ran).toEqual(["box", "false", "box:destroy"]);
  });

  test("commands.run returns a non-zero exit as data unless it is given exitCodes", async () => {
    const { client } = createFakeClient(() => {
      return { exitCode: 3 };
    });
    const fn = groupFunction(client, async (sandbox) => {
      const data = await sandbox.commands.run("plain", "x");
      const outcome = await sandbox.commands
        .run("strict", "x", { exitCodes: [0] })
        .catch((error: unknown) => {
          return getCommandError(error)?.name;
        });

      return [data.exitCode, outcome];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: [3, "CommandFailedError"] });
  });

  test("tails keep the last 8 KiB", async () => {
    const stderr = `${"a".repeat(10_000)}END`;
    const { client } = createFakeClient(() => {
      return { exitCode: 1, stderr };
    });
    const fn = groupFunction(client, async (sandbox) => {
      return sandbox.$`x`.catch((error: unknown) => {
        return getCommandError(error)?.stderrTail;
      });
    });

    const { result } = await runAll(fn);
    const tail = (result as { data: string }).data;

    expect(tail).toHaveLength(8 * 1024);
    expect(tail.endsWith("aaaEND")).toBe(true);
  });
});

describe("getCommandError", () => {
  test("reads a payload through a StepError, and ignores other errors", () => {
    const thrown = commandFailure({
      command: "make",
      exitCode: 2,
      stdout: "",
      stderr: "no rule",
    });
    const step = new StepError("make", {
      name: thrown.name,
      message: thrown.message,
      cause: thrown.cause,
    });

    expect(getCommandError(step)).toMatchObject({
      name: "CommandFailedError",
      command: "make",
      exitCode: 2,
      stderrTail: "no rule",
    });
    expect(getCommandError(new Error("nope"))).toBeUndefined();
    expect(getCommandError(undefined)).toBeUndefined();
  });

  test("tells a timeout from a failed exit by name", () => {
    const thrown = commandFailure({
      command: "sleep 1000",
      timeout: "5m",
      stdout: "",
      stderr: "",
    });
    const error = getCommandError(thrown);

    expect(error).toBeInstanceOf(CommandTimeoutError);
    expect(error?.name).toBe("CommandTimeoutError");
    expect(error?.message).toBe("Command timed out after 5m: sleep 1000");
  });
});

describe("timeouts", () => {
  test("a captured command that outlives its timeout is a CommandTimeoutError", async () => {
    const { client } = createFakeClient(() => {
      return { timesOut: true };
    });
    const fn = groupFunction(client, async (sandbox) => {
      return sandbox.$({ timeout: "30s" })`sleep 99`.catch((error: unknown) => {
        return getCommandError(error)?.message;
      });
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: "Command timed out after 30s: sleep 99",
    });
  });
});

describe("long commands", () => {
  test("over five minutes a command runs as a process, on one row, with # step IDs", async () => {
    const { client, execs } = createFakeClient(() => {
      return { stdout: "built\n", runningWaits: 2 };
    });
    const fn = groupFunction(client, async (sandbox) => {
      const result = await sandbox.$({ timeout: "20m" })`make all`;

      return [result.stdout, result.exitCode];
    });

    const { result, ran, steps } = await runAll(fn);

    expect(result).toMatchObject({ data: ["built\n", 0] });
    expect(ran).toEqual([
      "box",
      "make all",
      "make all #wait-1",
      "make all #wait-2",
      "make all #wait-3",
      "make all #output",
      "box:destroy",
    ]);
    expect(execs).toHaveLength(1);
    expect(execs[0]?.body.command).toEqual(["make", "all"]);

    // One `$` row, however many steps
    const spans = steps.slice(1, -1).map((step) => {
      return step.opts?.span as { kind: string; name: string }[];
    });

    expect(
      new Set(spans.map((span) => JSON.stringify(span?.at(-1)))).size,
    ).toBe(1);
    expect(spans[0]?.at(-1)).toMatchObject({ kind: "$", name: "make all" });
  });

  test("a disallowed exit fails the output step", async () => {
    const { client } = createFakeClient(() => {
      return { stdout: "o", stderr: "e", exitCode: 4 };
    });
    const fn = groupFunction(client, async (sandbox) => {
      return sandbox.$({ timeout: "6m" })`make`.catch((error: unknown) => {
        const command = getCommandError(error);

        return [command?.name, command?.stdoutTail, command?.stderrTail];
      });
    });

    const { result, steps } = await runAll(fn);
    const output = steps.find((step) => step.userland?.id === "make #output");

    expect(output?.error).toMatchObject({ name: "NonRetriableError" });
    expect(result).toMatchObject({
      data: ["CommandFailedError", "o", "e"],
    });
  });

  test("a process that outlives the timeout is stopped, then reported as a timeout with its output", async () => {
    const { client, signals } = createFakeClient(() => {
      return { stdout: "partial", neverExits: true };
    });
    const fn = groupFunction(client, async (sandbox) => {
      return sandbox.$({ timeout: "5m31s" })`serve`.catch((error: unknown) => {
        const command = getCommandError(error);

        return [command?.name, command?.message, command?.stdoutTail];
      });
    });

    const { result, ran } = await runAll(fn);

    expect(signals).toEqual([{ signal: 15, includeChildren: true }]);
    expect(ran.filter((id) => id.startsWith("serve"))).toEqual([
      "serve",
      ...Array.from({ length: 12 }, (_, index) => `serve #wait-${index + 1}`),
      "serve #stop",
      "serve #output",
    ]);
    expect(result).toMatchObject({
      data: [
        "CommandTimeoutError",
        "Command timed out after 331s: serve",
        "partial",
      ],
    });
  });
});

describe("step IDs", () => {
  test("commands planned together get stable IDs, and each result is its own", async () => {
    const { client } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      return Promise.all([
        sandbox.$`echo a`.text(),
        sandbox.$`echo a`.text(),
        sandbox.$`echo b`.text(),
        sandbox.$({ id: "named" })`echo a`.text(),
      ]);
    });

    const { ran, hashed, result } = await runAll(fn);

    expect(result).toMatchObject({
      type: "function-resolved",
      data: ["echo a#1", "echo a#2", "echo b#1", "echo a#3"],
    });
    expect(ran.slice().sort()).toEqual(
      ["box", "box:destroy", "echo a", "echo a", "echo b", "named"].sort(),
    );
    expect(new Set(hashed).size).toBe(hashed.length);
  });

  test("repeats in order get the same IDs on a second run", async () => {
    const build = () => {
      return groupFunction(createFakeClient().client, async (sandbox) => {
        return [await sandbox.$`echo a`.text(), await sandbox.$`echo a`.text()];
      });
    };

    const first = await runAll(build());
    const again = await runAll(build());

    expect(first.result).toMatchObject({ data: ["echo a#1", "echo a#2"] });
    expect(first.ran).toEqual(["box", "echo a", "echo a", "box:destroy"]);
    expect(new Set(first.hashed).size).toBe(4);
    expect(again.hashed).toEqual(first.hashed);
  });

  test("two sandboxes running the same command do not clash", async () => {
    const { client } = createFakeClient();
    const fn = client.createFunction(
      { id: "two", triggers: [{ event: "dollar/run" }] },
      async ({ group }) => {
        return Promise.all([
          group.sandbox("one", (sandbox) => {
            return sandbox.$`echo same`.text();
          }),
          group.sandbox("two", (sandbox) => {
            return sandbox.$`echo same`.text();
          }),
        ]);
      },
    );

    const { hashed, result } = await runAll(fn);

    expect(result).toMatchObject({ type: "function-resolved" });
    expect(new Set(hashed).size).toBe(hashed.length);
  });
});

describe("every handle has $", () => {
  test("create, get, list, resume, group and await using", async () => {
    const { client } = createFakeClient();
    const fn = client.createFunction(
      { id: "handles", triggers: [{ event: "dollar/run" }] },
      async ({ step, group }) => {
        const created = await step.sandbox.create("made", {
          name: "made",
          vcpu: 2,
          memoryMb: 2048,
        });
        const got = await step.sandbox.get("got", sandboxId);
        const listed = await step.sandbox.list("listed");
        const resumed = await created.resume("resumed");
        const inGroup = await group.sandbox("box", async (sandbox) => {
          return sandbox.$.sh;
        });
        const handles = [created, got, listed.items[0], resumed, inGroup];

        {
          await using scoped = await step.sandbox.create("scoped", {
            name: "scoped",
            vcpu: 2,
            memoryMb: 2048,
          });

          handles.push(scoped.$.sh);
        }

        return handles.map((handle) => {
          return typeof (typeof handle === "function" ? handle : handle?.$);
        });
      },
    );

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      type: "function-resolved",
      data: Array.from({ length: 6 }, () => "function"),
    });
  });
});
