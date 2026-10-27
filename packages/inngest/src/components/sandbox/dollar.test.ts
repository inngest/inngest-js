/**
 * @module
 * Tests for `sandbox.$`: the template rules, options, exit codes and their
 * errors (including across a replay), the managed path for long commands,
 * and the step IDs of commands that repeat or run together.
 */

import { runFnWithStack } from "../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../types.ts";
import { _internals } from "../execution/engine.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { StepError } from "../StepError.ts";
import { clip, commandFailure, getCommandError } from "./commandError.ts";
import {
  buildArgv,
  buildShellString,
  commandId,
  type DollarValue,
} from "./dollar.ts";
import {
  createClient,
  ranStep,
  sandboxId,
  sandboxResource,
} from "./test-helpers.ts";
import { type DurableSandbox, SandboxValidationError } from "./types.ts";

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
  /**
   * A process ends killed by this signal, with no exit code.
   */
  exitSignal?: number;
  /**
   * A process ends in this state, with no exit code.
   */
  endsAs?: "LOST" | "FAILED";
};

const base64 = (text: string): string => {
  return Buffer.from(text).toString("base64");
};

type Exec = { body: Record<string, unknown> };

type Process = { script: Script; waits: number; killedBy?: number };

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
  const processes = new Map<string, Process>();

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
          stdout: base64(result.stdout ?? ""),
          stderr: base64(result.stderr ?? ""),
          encoding: "base64",
          exitCode: result.exitCode ?? 0,
        },
      });
    }

    if (path.endsWith("/processes") && method === "POST") {
      const parsed = JSON.parse(String(body)) as { command: string[] };
      const id = `33333333-3333-4333-8333-${String(processes.size + 1).padStart(12, "0")}`;

      execs.push({ body: parsed });
      processes.set(id, { script: run(parsed.command), waits: 0 });

      return Response.json(
        {
          data: {
            id,
            command: parsed.command,
            pid: 7,
            state: "RUNNING",
            startedAt: "2026-07-28T00:00:00Z",
          },
        },
        { status: 201 },
      );
    }

    const id = /\/processes\/([^/]+)\//.exec(path)?.[1] ?? "";
    const process = processes.get(id);

    if (process && path.endsWith("/wait")) {
      const { script: current } = process;

      process.waits++;

      if (process.killedBy !== undefined) {
        return Response.json({
          data: { id, state: "KILLED", terminationSignal: process.killedBy },
        });
      }

      if (current.neverExits || process.waits <= (current.runningWaits ?? 0)) {
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

      if (current.endsAs) {
        return Response.json({ data: { id, state: current.endsAs } });
      }

      if (current.exitSignal !== undefined) {
        return Response.json({
          data: { id, state: "KILLED", terminationSignal: current.exitSignal },
        });
      }

      return Response.json({
        data: { id, state: "EXITED", exitCode: current.exitCode ?? 0 },
      });
    }

    if (process && path.endsWith("/signals")) {
      const signal = JSON.parse(String(body)) as { signal: number };

      signals.push(signal);

      process.killedBy = signal.signal;

      return new Response(null, { status: 204 });
    }

    if (process && path.endsWith("/output")) {
      return Response.json({
        data: {
          chunks: [
            {
              stream: "STDOUT",
              data: base64(process.script.stdout ?? ""),
              encoding: "base64",
            },
            {
              stream: "STDERR",
              data: base64(process.script.stderr ?? ""),
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
  const priorDefers = Object.fromEntries(
    ["box", "one", "two", "scoped"].map((name) => {
      return [_internals.hashId(`${name}:cleanup`), {}];
    }),
  );
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
    const result = await runFnWithStack(fn, stepState, { priorDefers });
    const complete =
      result.type === "steps-found"
        ? result.steps.find((step) => {
            return step.id === _internals.hashId("complete");
          })
        : undefined;

    if (complete) {
      return {
        ran,
        hashed,
        steps,
        result: {
          type:
            complete.op === StepOpCode.RunComplete
              ? ("function-resolved" as const)
              : ("function-rejected" as const),
          data: complete.data,
        },
      };
    }

    if (result.type === "step-ran") {
      memoize(result.step);
    } else if (result.type === "steps-found") {
      for (const found of result.steps) {
        const done = await runFnWithStack(fn, stepState, {
          runStep: found.id,
          priorDefers,
        });
        const step = ranStep(done);

        if (step) {
          memoize(step);
        }
      }
    } else {
      return { ran, hashed, steps, result };
    }
  }

  throw new Error("The function did not finish");
};

const findStep = (steps: OutgoingOp[], id: string) => {
  return steps.find((step) => {
    return step.userland?.id === id;
  });
};

/**
 * The distinct `$` row spans of the steps of one command, so one means that
 * all its steps are one row.
 */
const rowSpans = (steps: OutgoingOp[], id: string): Set<string> => {
  return new Set(
    steps
      .filter((step) => {
        return step.userland?.id?.startsWith(id);
      })
      .map((step) => {
        return JSON.stringify(
          (step.opts?.span as { kind: string; name: string }[]).at(-1),
        );
      }),
  );
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

  test("$.sh refuses a value inside quotes or after a backslash", () => {
    const input = "$(printf INJECTED)";

    expect(() => {
      return shell`echo "${input}"`;
    }).toThrow(SandboxValidationError);
    expect(() => {
      return shell`echo '${input}'`;
    }).toThrow(SandboxValidationError);
    expect(() => {
      return shell`echo \\${input}`;
    }).toThrow(SandboxValidationError);
    expect(() => {
      return shell`echo "a" ${"b"} 'c d' ${input} "e\\"f" ${input}`;
    }).not.toThrow();
  });

  test("the default step ID is the command, cut to 60 characters", () => {
    expect(commandId("npm test")).toBe("npm test");
    expect(commandId("x".repeat(80))).toHaveLength(60);
    expect(commandId("x".repeat(80)).endsWith("…")).toBe(true);
  });

  test("the default step ID has no newlines and never splits a character", () => {
    expect(commandId("set -e\n  make\tall")).toBe("set -e make all");
    expect([...commandId("😀".repeat(80))]).toHaveLength(60);
    expect(commandId("😀".repeat(80))).not.toContain("\uFFFD");
  });

  test("clip keeps a replacement character the text already had", () => {
    expect(clip("\uFFFDab", 10, "end")).toBe("\uFFFDab");
    expect(clip("😀😀", 5, "end")).toBe("😀");
    expect(clip("ab😀", 3, "start")).toBe("ab…");
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
    expect(
      execs.map((exec) => {
        return exec.body.command;
      }),
    ).toEqual([
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

    expect(
      execs.map((exec) => {
        return exec.body;
      }),
    ).toMatchObject([
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

    expect(
      execs.map((exec) => {
        return exec.body.timeout;
      }),
    ).toEqual(["300000ms", "10000ms"]);
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
    const command = findStep(steps, "deploy");

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

  test("a disallowed exit fails the step without retries, and the handler reads a failed command error", async () => {
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
          ...command,
        };
      }

      throw new Error("The command did not fail");
    });

    const { result, steps } = await runAll(fn);
    const failed = findStep(steps, "npm test");

    // The failure is the step's own, and is final
    expect(failed?.error).toMatchObject({ name: "NonRetriableError" });
    expect(result).toMatchObject({
      data: {
        step: true,
        type: "failed",
        command: "npm test",
        exitCode: 2,
        message: "Command failed with exit code 2: npm test",
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
          return getCommandError(error)?.type;
        });

      return [data.exitCode, outcome];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: [3, "failed"] });
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
      type: "failed",
      reason: "failed with exit code 2",
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
      type: "failed",
      command: "make",
      exitCode: 2,
      stderrTail: "no rule",
    });
    expect(getCommandError(new Error("nope"))).toBeUndefined();
    expect(getCommandError(undefined)).toBeUndefined();
  });

  test("tells a timeout from a failed exit by type", () => {
    const thrown = commandFailure({
      type: "timeout",
      reason: "timed out after 5m",
      command: "sleep 1000",
      stdout: "",
      stderr: "",
    });
    const error = getCommandError(thrown);

    expect(error?.type).toBe("timeout");
    expect(error?.exitCode).toBeUndefined();
    expect(error?.message).toBe("Command timed out after 5m: sleep 1000");
  });

  test("the command in an error is cut to 1 KiB, in the message too", () => {
    const error = getCommandError(
      commandFailure({
        type: "failed",
        reason: "failed with exit code 1",
        command: `echo ${"é".repeat(2000)}`,
        exitCode: 1,
        stdout: "",
        stderr: "",
      }),
    );

    expect(new TextEncoder().encode(error?.command).byteLength).toBeLessThan(
      1030,
    );
    expect(error?.command.endsWith("…")).toBe(true);
    expect(error?.message).toBe(
      `Command failed with exit code 1: ${error?.command}`,
    );
  });
});

describe("timeouts", () => {
  test("a captured command that outlives its timeout is a timeout command error", async () => {
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

  test("its tails are empty, as the server returns no output for it", async () => {
    const { client } = createFakeClient(() => {
      return { timesOut: true };
    });
    const fn = groupFunction(client, async (sandbox) => {
      return sandbox.$({ timeout: "30s" })`sleep 99`.catch((error: unknown) => {
        return getCommandError(error);
      });
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: { type: "timeout", stdoutTail: "", stderrTail: "" },
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

    const spans = rowSpans(steps, "make all");

    expect(spans.size).toBe(1);
    expect(JSON.parse([...spans][0]!)).toMatchObject({
      kind: "$",
      name: "make all",
    });
  });

  test("a disallowed exit fails the output step", async () => {
    const { client } = createFakeClient(() => {
      return { stdout: "o", stderr: "e", exitCode: 4 };
    });
    const fn = groupFunction(client, async (sandbox) => {
      return sandbox.$({ timeout: "6m" })`make`.catch((error: unknown) => {
        const command = getCommandError(error);

        return [command?.type, command?.stdoutTail, command?.stderrTail];
      });
    });

    const { result, steps } = await runAll(fn);
    const output = findStep(steps, "make #output");

    expect(output?.error).toMatchObject({ name: "NonRetriableError" });
    expect(result).toMatchObject({ data: ["failed", "o", "e"] });
  });

  test("a process that outlives the timeout is killed once, on the same row, and reported as a timeout with its output", async () => {
    const { client, signals } = createFakeClient(() => {
      return { stdout: "partial", neverExits: true };
    });
    const fn = groupFunction(client, async (sandbox) => {
      return sandbox.$({ timeout: "5m31s" })`serve`.catch((error: unknown) => {
        const command = getCommandError(error);

        return [command?.type, command?.message, command?.stdoutTail];
      });
    });

    const { result, ran, steps } = await runAll(fn);

    expect(signals).toEqual([{ signal: 9, includeChildren: true }]);
    expect(rowSpans(steps, "serve").size).toBe(1);
    expect(
      ran.filter((id) => {
        return id.startsWith("serve");
      }),
    ).toEqual([
      "serve",
      "serve #wait-1",
      "serve #wait-2",
      "serve #stop",
      "serve #output",
    ]);
    expect(result).toMatchObject({
      data: [
        "timeout",
        "Command timed out after 331s and was killed: serve",
        "partial",
      ],
    });
  });

  test("a process stopped by a signal exits as 128 plus the signal", async () => {
    const { client } = createFakeClient(() => {
      return { exitSignal: 9 };
    });
    const fn = groupFunction(client, async (sandbox) => {
      const data = await sandbox.commands.run("any", "x", { timeout: "6m" });
      const failed = await sandbox.$({ timeout: "6m" })`strict`.catch(
        (error: unknown) => {
          return getCommandError(error);
        },
      );

      return [data.exitCode, failed?.exitCode];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: [137, 137] });
  });

  test("a process that ends LOST or FAILED is reported by its state, with no exit code", async () => {
    const { client } = createFakeClient((text) => {
      return { endsAs: text === "lost" ? "LOST" : "FAILED" };
    });
    const fn = groupFunction(client, async (sandbox) => {
      const lost = await sandbox.$({
        timeout: "6m",
        exitCodes: "any",
      })`lost`.catch((error: unknown) => {
        return getCommandError(error);
      });
      const failed = await sandbox.commands
        .run("failed", "failed", { timeout: "6m" })
        .catch((error: unknown) => {
          return getCommandError(error);
        });

      return [lost, failed];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: [
        { type: "failed", message: "Command ended LOST: lost" },
        { type: "failed", message: "Command ended FAILED: failed" },
      ],
    });
    expect(
      (result as { data: { exitCode?: number }[] }).data.map((error) => {
        return error.exitCode;
      }),
    ).toEqual([undefined, undefined]);
  });

  test("commands.run over five minutes returns a non-zero exit as data by default", async () => {
    const { client } = createFakeClient(() => {
      return { exitCode: 3, stdout: "partial" };
    });
    const fn = groupFunction(client, async (sandbox) => {
      const result = await sandbox.commands.run("long", "x", {
        timeout: "6m",
      });

      return [result.exitCode, result.stdout, result.output];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: [3, "partial", { truncated: false }],
    });
  });

  test("a tail over 8 KiB keeps whole characters", async () => {
    const stderr = "é".repeat(5000);
    const { client } = createFakeClient(() => {
      return { exitCode: 1, stderr };
    });
    const fn = groupFunction(client, async (sandbox) => {
      return sandbox.$({ timeout: "6m" })`x`.catch((error: unknown) => {
        return getCommandError(error)?.stderrTail;
      });
    });

    const { result } = await runAll(fn);
    const tail = (result as { data: string }).data;

    expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(
      8 * 1024,
    );
    expect(tail).toMatch(/^é+$/);
  });

  test("the env is redacted from every step of a long command, and still reaches it", async () => {
    const { client, execs } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      await sandbox.$({ timeout: "6m", env: { TOKEN: "hunter2" } })`deploy`;
    });

    const { steps } = await runAll(fn);

    expect(steps.length).toBeGreaterThan(3);
    expect(JSON.stringify(steps)).not.toContain("hunter2");
    expect(execs[0]?.body).toMatchObject({ environment: { TOKEN: "hunter2" } });
  });

  test("a long command that repeats gets each result from its own process", async () => {
    const build = (together: boolean) => {
      const { client } = createFakeClient();

      return groupFunction(client, async (sandbox) => {
        const make$ = sandbox.$({ timeout: "6m" });

        if (together) {
          return Promise.all([make$`make`.text(), make$`make`.text()]);
        }

        return [await make$`make`.text(), await make$`make`.text()];
      });
    };

    for (const together of [false, true]) {
      const { result, hashed } = await runAll(build(together));

      expect(result).toMatchObject({ data: ["make#1", "make#2"] });
      expect(new Set(hashed).size).toBe(hashed.length);
    }
  });
});

describe("validation and helpers", () => {
  test("an empty command is a validation error", async () => {
    const { client, execs } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      const argv = await sandbox.$``.catch((error: unknown) => {
        return error instanceof SandboxValidationError;
      });
      const script = await sandbox.$.sh``.catch((error: unknown) => {
        return error instanceof SandboxValidationError;
      });

      return [argv, script];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: [true, true] });
    expect(execs).toEqual([]);
  });

  test('options must be known keys, and exitCodes integers or "any"', async () => {
    const { client } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      const rejects = (options: object) => {
        try {
          sandbox.$(options);
        } catch (error) {
          return error instanceof SandboxValidationError;
        }

        return false;
      };

      return [
        rejects({ exitCodes: [0, 1.5] }),
        rejects({ exitCodes: "some" }),
        rejects({ retries: 3 }),
        rejects({ exitCodes: [0], cwd: "/work" }),
      ];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: [true, true, true, false] });
  });

  test("commands.run rejects exitCodes with tools, and non-integer exitCodes, at runtime", async () => {
    const { client, execs } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      const run = sandbox.commands.run as (
        id: string,
        command: string,
        options: object,
      ) => Promise<unknown>;
      const rejected = (options: object) => {
        return run("x", "x", options).catch((error: unknown) => {
          return error instanceof SandboxValidationError;
        });
      };

      return [
        await rejected({ exitCodes: [0], tools: {} }),
        await rejected({ exitCodes: [0.5] }),
      ];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({ data: [true, true] });
    expect(execs).toEqual([]);
  });

  test("exitCodes can't be used with tools", () => {
    const check = (sandbox: DurableSandbox) => {
      sandbox.commands.run("ok", "x", { tools: {} });
      sandbox.commands.run("ok", "x", { exitCodes: [0] });
      // @ts-expect-error exitCodes and tools exclude each other
      sandbox.commands.run("bad", "x", { exitCodes: [0], tools: {} });
    };

    expect(check).toBeTypeOf("function");
  });

  test("an option set to undefined leaves the default, and an id is for one `$` only", async () => {
    const { client, execs } = createFakeClient();
    const fn = groupFunction(client, async (sandbox) => {
      const repo$ = sandbox.$({ cwd: "/work" });

      await repo$({ cwd: undefined })`pwd`;
      await repo$({ id: "named" })`pwd`;
      await repo$`pwd`;
    });

    const { ran } = await runAll(fn);

    expect(
      execs.map((exec) => {
        return exec.body.cwd;
      }),
    ).toEqual(["/work", "/work", "/work"]);
    expect(ran).toEqual(["box", "pwd", "named", "pwd", "box:destroy"]);
  });

  test("text trims, lines split on CRLF, and json names the command when it fails", async () => {
    const { client } = createFakeClient((text) => {
      return { stdout: text === "bad" ? "not json" : "  a\r\nb\r\n\n " };
    });
    const fn = groupFunction(client, async (sandbox) => {
      return [
        await sandbox.$`text`.text(),
        await sandbox.$`lines`.lines(),
        await sandbox.$`bad`.json().catch((error: Error) => {
          return [
            error.name,
            error.message,
            error.cause instanceof SyntaxError,
          ];
        }),
      ];
    });

    const { result } = await runAll(fn);

    expect(result).toMatchObject({
      data: [
        "a\r\nb",
        ["  a", "b"],
        ["NonRetriableError", "Output of command is not valid JSON: bad", true],
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
      data: Array.from({ length: 6 }, () => {
        return "function";
      }),
    });
  });
});
