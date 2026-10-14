/**
 * @module
 * EXPERIMENTAL: Runs a sandbox command whose code can call tools.
 *
 * The first step starts the process and waits, in the same moment, for it to
 * exit or make its first request. A command that never calls a tool is one
 * step and about one round trip, the same as a plain `commands.run`. From then
 * on each round is:
 *
 * 1. One step per request (`<id>:tool:<name>:<id>`) runs the tool and returns
 *    just the reply body, so a tool is memoized the moment it returns.
 * 2. One wait step (`<id>:wait:<n>`) uploads those replies (same bytes to the
 *    same path, so a retry is harmless), then blocks inside the sandbox until
 *    the request log grows, the process exits, or the wait window ends.
 *
 * The wait window is a ceiling, not a delay: it ends the moment there is news.
 * A quiet stretch longer than the window continues in a fresh wait step.
 *
 * Requests go to an append-only log read by line count, so output is never
 * re-read, and user output stays in files until the process exits.
 */

import type { StepOptions, StepOptionsOrId } from "../../types.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import { getStepOptions, withSpan } from "../InngestStepTools.ts";
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
  parseToolRequest,
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

const maxConcurrentCalls = 8;

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
   * Lines of the request log consumed so far.
   */
  lines: number;

  /**
   * Complete lines of the request log that are new.
   */
  requests: string[];

  /**
   * Set once the command has exited.
   */
  result?: SandboxOperationResultV1;
}

interface Reply {
  id: number;
  body: string;
}

const errorMessage = (error: unknown): string => {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
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
  const meta = sandboxTraceMetadata(operation, { error: undefined });

  const sdkStep = (stepId: string, name: string): StepOptions => {
    return { id: stepId, name, "~origin": sdkOrigin };
  };

  /**
   * Uploads replies while waiting for news, since the code can't ask for
   * anything new until it has its reply.
   */
  const follow = async (
    dir: string,
    lines: number,
    replies: Reply[],
  ): Promise<Round> => {
    const seconds = Math.ceil(waitWindowMs / 1000);
    const [waited] = await Promise.all([
      sandbox.commands.run(
        ["/bin/sh", "-c", waiterScript, "sh", dir, `${lines}`, `${seconds}`],
        { timeout: (seconds + 30) * 1000 },
      ),
      ...replies.map((reply) => {
        return sandbox.files.upload({
          path: `${dir}/${reply.id}.json`,
          data: reply.body,
        });
      }),
    ]);
    const [code = "", stdout = "", stderr = "", ...rest] =
      waited.stdout.split("\n");
    // Whatever follows the last newline is a cut-off line, or nothing.
    const requests = rest.slice(0, -1);

    return {
      now: Date.now(),
      lines: lines + requests.length,
      requests,
      ...(code !== "" && {
        result: execOperationResult({
          stdout: decodeBase64(stdout, "stdout"),
          stderr: decodeBase64(stderr, "stderr"),
          exitCode: Number(code),
        }),
      }),
    };
  };

  const abort = async (processId: string, reason: string): Promise<never> => {
    await host.run(sdkStep(`${id}:abort`, "Stop command"), async () => {
      const process = await sandbox.processes.get(processId);

      await process?.signal({ signal: 9 });

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
  }): Promise<Reply> => {
    const resolved = await resolveToolCall(tools, call, line);
    if ("error" in resolved) {
      return { id: call.id, body: JSON.stringify({ error: resolved.error }) };
    }

    const stepId = `${id}:tool:${call.tool}:${call.id}`;

    try {
      const body = await host.run(
        {
          id: stepId,
          name: call.tool,
          "~origin": sdkOrigin,
          "~span": {
            id: stepId,
            name: call.tool,
            kind: "tool",
            origin: sdkOrigin,
          },
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
            resolved.invoke({
              signal,
              idempotencyKey: `${host.runId ?? ""}:${stepId}`,
            }),
            timedOut,
          ]);
          const text = JSON.stringify({ result: value ?? null });

          if (byteLength(text) > maxToolReplyBytes) {
            throw new NonRetriableError(
              `${call.tool} returned more than ${maxToolReplyBytes} bytes; write large data to a file instead`,
            );
          }

          return text;
        },
      );

      return { id: call.id, body };
    } catch (error) {
      return {
        id: call.id,
        body: JSON.stringify({ error: errorMessage(error) }),
      };
    }
  };

  const started = await host.run(
    idOrOptions,
    async () => {
      const dir = `${toolsRoot}/${crypto.randomUUID()}`;
      const startedAt = Date.now();
      // The wait doesn't need the process to exist yet, so it runs alongside.
      const [process, round] = await Promise.allSettled([
        sandbox.processes.start({
          command: ["/bin/sh", "-c", wrapperScript, "sh", ...command],
          environment: { ...environment, INNGEST_TOOLS_DIR: dir },
          ...(cwd !== undefined && { cwd }),
        }),
        follow(dir, 0, []),
      ]);

      if (process.status === "rejected") {
        throw process.reason;
      }

      // The command is running, and a retry would start another.
      if (round.status === "rejected") {
        throw new NonRetriableError(
          `Command started but could not be followed: ${errorMessage(round.reason)}`,
          { cause: round.reason },
        );
      }

      return { ...round.value, processId: process.value.id, dir, startedAt };
    },
    meta,
  );

  const seen = new Set<number>();
  let state: Round = started;
  let calls = 0;
  let waits = 0;

  for (;;) {
    if (state.result) {
      return state.result;
    }

    if (state.now - started.startedAt > timeoutMs) {
      return abort(
        started.processId,
        `Command with tools exceeded its ${timeoutMs}ms timeout`,
      );
    }

    const pending: { request: ToolRequest; line: string }[] = [];
    for (const line of state.requests) {
      const request = parseToolRequest(line);
      if (!request || seen.has(request.id)) {
        continue;
      }

      seen.add(request.id);

      if (++calls > maxCalls) {
        return abort(
          started.processId,
          `Command made more than ${maxCalls} tool calls`,
        );
      }

      pending.push({ request, line });
    }

    const replies: Reply[] = [];
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
        return follow(started.dir, lines, replies);
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
