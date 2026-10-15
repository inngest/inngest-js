/**
 * @module
 * EXPERIMENTAL: Runs a sandbox command whose code can call tools.
 *
 * The first step starts the process and waits, in the same moment, for it to
 * exit or make its first request. The process's directory is named for the run
 * and step, and the wrapper claims it, so a retry of this step starts a process
 * that exits at once and only waits on the first. A command that never calls a
 * tool is one step and one round trip. From then on each round is:
 *
 * 1. One step per request (`<id>:tool:<name>:<id>`) runs the tool and returns
 *    just the reply line, so a tool is memoized the moment it returns.
 * 2. One wait step (`<id>:wait:<n>`) appends those replies to the sandbox's
 *    `ops.log`, then blocks inside the sandbox until the log has a new request
 *    or the exit, or the wait window ends. A retry appends them again, which
 *    the stub ignores.
 *
 * The wait window is a ceiling, not a delay: the waiter polls every 20ms and
 * ends soon after there is news. A quiet stretch longer than the window
 * continues in a fresh wait step.
 *
 * The host reads the log by line count, and user output stays
 * in files until the process exits. `toolStubs.ts` describes the log.
 */

import hashjs from "hash.js";
import type { StepOptions, StepOptionsOrId, StepSpan } from "../../types.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import {
  getStepOptions,
  withSpan,
  withStepIdPrefix,
} from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { execOperationResult } from "./durable.ts";
import type {
  SandboxOperationForAction,
  SandboxOperationResultV1,
} from "./protocol.ts";
import { toolsRoot, waiterScript, wrapperScript } from "./toolStubs.ts";
import {
  byteLength,
  maxToolReplyBytes,
  parseToolEvent,
  resolveToolCall,
  type SandboxToolsRequest,
  type ToolRequest,
  validateTools,
} from "./tools.ts";
import {
  type SandboxTraceMetadata,
  sandboxTraceMetadata,
  sdkOrigin,
} from "./trace.ts";
import { type Sandbox, SandboxValidationError } from "./types.ts";
import {
  decodeBase64,
  maxSandboxProcessTimeoutMs,
  normalizeDurationMs,
} from "./validation.ts";

const { sha256 } = hashjs;

const maxConcurrentCalls = 8;

/**
 * The most a reply may weigh to ride in the waiter's command, which is capped
 * at 32 KiB in all with a batch of 8. Larger replies go up as files.
 */
const maxInlineReplyBytes = 3 * 1024;

/**
 * How the engine runs steps and reaches the sandbox. `middleware.ts` supplies
 * the real one, and the tests supply a fake.
 */
export interface ToolsHost {
  /**
   * Runs `fn` as a durable step. `meta` describes the step for the trace.
   */
  run: <T>(
    idOrOptions: StepOptionsOrId,
    fn: () => Promise<T>,
    meta?: SandboxTraceMetadata,
  ) => Promise<T>;

  /**
   * The direct client's sandbox, for use inside a step.
   */
  sandbox: Sandbox;

  /**
   * Scopes idempotency keys to the run.
   */
  runId?: string;
}

/**
 * What a step learned from the sandbox.
 */
interface Round {
  /**
   * Epoch ms when the step finished, for the run's wall-clock timeout.
   */
  now: number;

  /**
   * Lines of `ops.log` consumed so far.
   */
  lines: number;

  /**
   * The requests among the new lines, each with the line it arrived as.
   */
  requests: { request: ToolRequest; line: string }[];

  /**
   * Set once the command has exited.
   */
  result?: SandboxOperationResultV1;
}

const errorMessage = (error: unknown): string => {
  return String(error instanceof Error ? error.message : error).slice(0, 2000);
};

const toolSpan = (stepId: string, name: string): StepSpan => {
  return { id: stepId, name, kind: "tool", origin: sdkOrigin };
};

/**
 * The `ops.log` line that answers request `id`.
 */
const replyLine = (
  id: number,
  outcome: { result: unknown } | { error: string },
): string => {
  return JSON.stringify({ op: "reply", id, ...outcome });
};

/**
 * The reply line for a tool's result.
 */
const resultLine = (id: number, name: string, value: unknown): string => {
  const line = replyLine(id, { result: value ?? null });

  if (byteLength(line) > maxToolReplyBytes) {
    throw new NonRetriableError(
      `${name} returned more than ${maxToolReplyBytes} bytes; write large data to a file instead`,
    );
  }

  return line;
};

/**
 * Runs `operation` (a `commands.run` call) with `request.tools` available to
 * the code it runs.
 */
const followCommand = async (
  host: ToolsHost,
  idOrOptions: StepOptionsOrId,
  operation: SandboxOperationForAction<"exec">,
  { tools, toolOptions = {} }: SandboxToolsRequest,
): Promise<SandboxOperationResultV1> => {
  validateTools(tools);

  const { id } = getStepOptions(idOrOptions);
  const waitWindowMs = normalizeDurationMs(
    toolOptions.waitWindow ?? 20_000,
    120_000,
    "toolOptions.waitWindow",
  );
  const toolTimeoutMs = normalizeDurationMs(
    toolOptions.toolTimeout ?? 30_000,
    maxSandboxProcessTimeoutMs,
    "toolOptions.toolTimeout",
  );
  const maxCalls = toolOptions.maxCalls ?? 100;
  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    throw new SandboxValidationError(
      "toolOptions.maxCalls must be a whole number from 1",
    );
  }

  const [{ command, environment, cwd, timeoutMs }] = operation.input;
  const { sandbox } = host;
  // Concurrent callers of a group tool share step IDs, so their prefix tells
  // them apart
  const scope = `${host.runId ?? ""}:${getAsyncCtxSync()?.execution?.stepIdPrefix ?? ""}`;
  const dir = `${toolsRoot}/${sha256().update(`${scope}${id}`).digest("hex")}`;
  const meta = sandboxTraceMetadata(operation, { error: undefined });

  const sdkStep = (stepId: string, name: string): StepOptions => {
    return { id: stepId, name, "~origin": sdkOrigin };
  };

  /**
   * Replies ride in the waiter's command while they're small. A larger one is
   * uploaded, and the command names its file.
   */
  const stage = (replies: string[]): Promise<string[]> => {
    return Promise.all(
      replies.map(async (reply, index) => {
        if (byteLength(reply) <= maxInlineReplyBytes) {
          return reply;
        }

        const path = `${dir}/reply.${index}`;
        await sandbox.files.upload({ path, data: `${reply}\n` });

        return `@${path}`;
      }),
    );
  };

  /**
   * Has the waiter append `replies`, then wait for news, since the code can't
   * ask for anything new until it has its reply.
   */
  const follow = async (lines: number, replies: string[]): Promise<Round> => {
    const seconds = Math.ceil(waitWindowMs / 1000);
    const waited = await sandbox.commands.run(
      [
        "/bin/sh",
        "-c",
        waiterScript,
        "sh",
        dir,
        `${lines}`,
        `${seconds}`,
        ...(await stage(replies)),
      ],
      { timeout: (seconds + 30) * 1000 },
    );
    // Whatever follows the last newline is a cut-off line, or nothing.
    const log = waited.stdout.split("\n").slice(0, -1);
    const requests: Round["requests"] = [];
    let result: SandboxOperationResultV1 | undefined;

    for (const line of log) {
      const event = parseToolEvent(line);
      if (event?.op === "call") {
        requests.push({ request: event, line });
      } else if (event?.op === "exit") {
        result = execOperationResult({
          stdout: decodeBase64(event.stdout, "stdout"),
          stderr: decodeBase64(event.stderr, "stderr"),
          exitCode: event.code,
        });
      }
    }

    return { now: Date.now(), lines: lines + log.length, requests, result };
  };

  const abort = async (reason: string): Promise<never> => {
    await host.run(sdkStep(`${id}:abort`, "Stop command"), async () => {
      await sandbox.commands.run([
        "/bin/sh",
        "-c",
        'pkill -9 -P "$(cat "$1/pid")"; kill -9 "$(cat "$1/pid")"',
        "sh",
        dir,
      ]);

      return { reason };
    });

    throw new Error(reason);
  };

  const answer = async ({
    request: call,
    line,
  }: {
    request: ToolRequest;
    line: string;
  }): Promise<string> => {
    const resolved = await resolveToolCall(tools, call, line);
    if (resolved.error !== undefined) {
      return replyLine(call.id, { error: resolved.error });
    }

    const stepId = `${id}:tool:${call.tool}:${call.id}`;
    const idempotencyKey = `${scope}${stepId}`;

    try {
      if (resolved.group) {
        // The body's own steps are the durable part, so there is no step here.
        const value = await withSpan(
          { ...toolSpan(stepId, call.tool), origin: undefined },
          () => {
            return withStepIdPrefix(`${stepId}:`, () => {
              return resolved.invoke({
                signal: new AbortController().signal,
                idempotencyKey,
              });
            });
          },
        );

        return resultLine(call.id, call.tool, value);
      }

      return await host.run(
        {
          id: stepId,
          name: call.tool,
          "~origin": sdkOrigin,
          "~span": toolSpan(stepId, call.tool),
        },
        async () => {
          const signal = AbortSignal.timeout(toolTimeoutMs);
          const timedOut = new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => {
              reject(
                new Error(`${call.tool} timed out after ${toolTimeoutMs}ms`),
              );
            });
          });
          const value = await Promise.race([
            resolved.invoke({ signal, idempotencyKey }),
            timedOut,
          ]);

          return resultLine(call.id, call.tool, value);
        },
      );
    } catch (error) {
      return replyLine(call.id, { error: errorMessage(error) });
    }
  };

  const started = await host.run(
    idOrOptions,
    async () => {
      const startedAt = Date.now();
      // The wait doesn't need the process to exist yet, so it runs alongside.
      const [, round] = await Promise.all([
        sandbox.processes.start({
          command: ["/bin/sh", "-c", wrapperScript, "sh", dir, ...command],
          ...(environment && { environment }),
          ...(cwd !== undefined && { cwd }),
        }),
        follow(0, []),
      ]);

      return { ...round, startedAt };
    },
    meta,
  );

  const seen = new Set<number>();
  let state: Round = started;
  let waits = 0;

  for (;;) {
    if (state.result) {
      return state.result;
    }

    if (state.now - started.startedAt > timeoutMs) {
      return abort(`Command with tools exceeded its ${timeoutMs}ms timeout`);
    }

    const pending: Round["requests"] = [];
    for (const { request, line } of state.requests) {
      if (seen.has(request.id)) {
        continue;
      }

      seen.add(request.id);

      if (seen.size > maxCalls) {
        return abort(`Command made more than ${maxCalls} tool calls`);
      }

      pending.push({ request, line });
    }

    const replies: string[] = [];
    for (let at = 0; at < pending.length; at += maxConcurrentCalls) {
      replies.push(
        ...(await Promise.all(
          pending.slice(at, at + maxConcurrentCalls).map(answer),
        )),
      );
    }

    const { lines } = state;
    state = await host.run(
      sdkStep(`${id}:wait:${++waits}`, runningNames[commandKind(command)]),
      () => {
        return follow(lines, replies);
      },
      { ...meta, kind: "wait" },
    );
  }
};

const pythonProgram = /^python[\d.]*$/;

const tsPrograms = new Set(["node", "tsx", "bun", "deno"]);

const shellPrograms = new Set(["sh", "bash", "zsh", "dash"]);

const basename = (path: string): string => {
  return path.split("/").pop() ?? "";
};

const runningNames = {
  python: "Python running…",
  typescript: "TypeScript running…",
  sh: "Waiting for tool calls",
};

/**
 * What the command runs, for the trace: `python`, `typescript` (node, tsx, bun and
 * deno) or `sh` for anything else. A string command arrives as `sh -c <script>`,
 * so the script's first word is the program.
 */
export const commandKind = ([
  program = "",
  ...rest
]: string[]): keyof typeof runningNames => {
  const [word = ""] =
    shellPrograms.has(basename(program)) && rest[0] === "-c"
      ? (rest[1] ?? "").trim().split(/\s+/)
      : [program];
  const name = basename(word);

  if (pythonProgram.test(name)) {
    return "python";
  }

  return tsPrograms.has(name) ? "typescript" : "sh";
};

/**
 * Runs `operation` (a `commands.run` call) with `request.tools` available to
 * the code it runs. All its steps share one trace group, kinded by what the
 * command runs, and each tool call is a `tool` row inside it.
 */
export const runCommandWithTools = (
  host: ToolsHost,
  idOrOptions: StepOptionsOrId,
  operation: SandboxOperationForAction<"exec">,
  request: SandboxToolsRequest,
): Promise<SandboxOperationResultV1> => {
  const { id, name } = getStepOptions(idOrOptions);
  const kind = commandKind(operation.input[0].command);
  const run = () => {
    return followCommand(host, idOrOptions, operation, request);
  };

  // A runner's own group of this kind already holds the command's steps.
  const group = getAsyncCtxSync()?.execution?.span?.at(-1);

  return group?.kind === kind ? run() : withSpan({ id, name, kind }, run);
};
