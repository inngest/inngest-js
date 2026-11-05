/**
 * @module
 * Test fixtures for the `$` and shell tests: a fake sandbox REST client whose
 * commands answer from a script, and a runner that drives a function request
 * by request, running the steps each request finds.
 */

import { runFnWithStack } from "../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../types.ts";
import { _internals } from "../execution/engine.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { createClient, ranStep, sandboxResource } from "./test-helpers.ts";
import type { DurableSandbox } from "./types.ts";

export type Script = {
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
export const createFakeClient = (
  script: (
    text: string,
    count: number,
    request: { cwd?: string; environment?: Record<string, string> },
  ) => Script = (text, count) => {
    return { stdout: `${text}#${count}` };
  },
) => {
  const execs: Exec[] = [];
  const signals: unknown[] = [];
  const counts = new Map<string, number>();
  const processes = new Map<string, Process>();

  const run = (
    command: string[],
    request: { cwd?: string; environment?: Record<string, string> },
  ) => {
    const text = command[0] === "/bin/sh" ? command[2]! : command.join(" ");
    const count = (counts.get(text) ?? 0) + 1;

    counts.set(text, count);

    return script(text, count, request);
  };

  const client = createClient((path, method, { body }) => {
    if (path.endsWith("/exec")) {
      const parsed = JSON.parse(String(body)) as {
        command: string[];
        cwd?: string;
        environment?: Record<string, string>;
      };

      execs.push({ body: parsed });
      const result = run(parsed.command, parsed);

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
      processes.set(id, { script: run(parsed.command, {}), waits: 0 });

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
export const runAll = async (fn: InngestFunction.Any) => {
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

export const findStep = (steps: OutgoingOp[], id: string) => {
  return steps.find((step) => {
    return step.userland?.id === id;
  });
};

/**
 * The distinct `$` row spans of the steps of one command, so one means that
 * all its steps are one row.
 */
export const rowSpans = (steps: OutgoingOp[], id: string): Set<string> => {
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

export const groupFunction = (
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
