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
 * A tool declared with `waits` suspends the code instead. Its call is answered
 * with a yield, the process exits, and the tool's body runs as steps with no
 * command running. Then `<id>:resume:<n>` starts the command again with the
 * reply of every call so far (the journal) uploaded for the stubs to replay.
 * Each resumed run is a segment: it has its own command clock and its tool
 * steps are named `<id>:r<n>:tool:<name>:<id>`.
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
import { installToolBinary } from "./toolBinary.ts";
import { toolsRoot, waiterScript, wrapperScript } from "./toolStubs.ts";
import {
  byteLength,
  callWaits,
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
import { type Sandbox, SandboxError, SandboxValidationError } from "./types.ts";
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
 * The most the replies of one wait may weigh inline, whatever their number.
 */
const maxInlineTotalBytes = maxConcurrentCalls * maxInlineReplyBytes;

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

  /**
   * The exit code in the log, set with `result`.
   */
  exitCode?: number;

  /**
   * Whether a stub wrote its yield line in these lines.
   */
  yielded?: boolean;

  /**
   * Whether a replaying stub wrote that it used the whole journal.
   */
  replayed?: boolean;
}

/**
 * A reply line as the journal keeps it, with the tool it answered and the
 * stub's hash of the arguments, so a replay that makes different calls ends
 * (exit 76) instead of getting another call's reply.
 */
const journaled = (line: string, request: ToolRequest): string => {
  return JSON.stringify({
    ...JSON.parse(line),
    tool: request.tool,
    h: request.h,
  });
};

/**
 * A reply, or a function that makes it when the wait step runs.
 */
type Reply = string | (() => Promise<string>);

const errorMessage = (error: unknown): string => {
  return String(error instanceof Error ? error.message : error).slice(0, 2000);
};

/**
 * Rejects once `signal` (by default a fresh one of `ms`) aborts.
 */
const timeoutAfter = (
  ms: number,
  tool: string,
  signal = AbortSignal.timeout(ms),
): Promise<never> => {
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => {
      reject(new Error(`${tool} timed out after ${ms}ms`));
    });
  });
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
 * the code it runs. Its steps are in the command's one `$` row, and each tool
 * call is a `tool` row inside it.
 */
export const runCommandWithTools = async (
  host: ToolsHost,
  idOrOptions: StepOptionsOrId,
  operation: SandboxOperationForAction<"exec">,
  {
    tools,
    toolOptions = {},
    binary,
    timeoutMs: requestedTimeoutMs,
    command: requestedCommand,
  }: SandboxToolsRequest,
): Promise<SandboxOperationResultV1> => {
  validateTools(tools);

  const { id } = getStepOptions(idOrOptions);
  // A command past five minutes waits in longer windows, to spend fewer steps.
  const waitWindowMs = normalizeDurationMs(
    toolOptions.waitWindow ??
      ((requestedTimeoutMs ?? 0) > maxSandboxProcessTimeoutMs
        ? 60_000
        : 20_000),
    240_000,
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

  const [
    {
      command: operationCommand,
      environment,
      cwd,
      timeoutMs: operationTimeoutMs,
    },
  ] = operation.input;
  const command = requestedCommand ?? operationCommand;
  const timeoutMs = requestedTimeoutMs ?? operationTimeoutMs;
  const { sandbox } = host;
  // Concurrent callers of a group tool share step IDs, so their prefix tells
  // them apart
  const scope = `${host.runId ?? ""}:${getAsyncCtxSync()?.execution?.stepIdPrefix ?? ""}`;
  const meta = sandboxTraceMetadata(operation, { error: undefined });

  const sdkStep = (stepId: string, name: string): StepOptions => {
    return { id: stepId, name, "~origin": sdkOrigin };
  };

  /**
   * Replies ride in the waiter's command while they're small. A larger one is
   * uploaded, and the command names its file.
   */
  const stage = (dir: string, replies: string[]): Promise<string[]> => {
    let inlineBytes = 0;

    return Promise.all(
      replies.map(async (reply, index) => {
        const size = byteLength(reply);
        if (
          size <= maxInlineReplyBytes &&
          inlineBytes + size <= maxInlineTotalBytes
        ) {
          inlineBytes += size;

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
  const follow = async (
    dir: string,
    lines: number,
    replies: string[],
    windowMs: number,
  ): Promise<Round> => {
    const seconds = Math.max(1, Math.ceil(windowMs / 1000));
    const waited = await sandbox.commands.run(
      [
        "/bin/sh",
        "-c",
        waiterScript,
        "sh",
        dir,
        `${lines}`,
        `${seconds}`,
        ...(await stage(dir, replies)),
      ],
      { timeout: (seconds + 30) * 1000 },
    );
    // Whatever follows the last newline is a cut-off line, or nothing.
    const log = waited.stdout.split("\n").slice(0, -1);
    const requests: Round["requests"] = [];
    let result: SandboxOperationResultV1 | undefined;
    let exitCode: number | undefined;
    let yielded = false;
    let replayed = false;

    for (const line of log) {
      const event = parseToolEvent(line);
      if (event?.op === "call") {
        requests.push({ request: event, line });
      } else if (event?.op === "yielded") {
        yielded = true;
      } else if (event?.op === "replayed") {
        replayed = true;
      } else if (event?.op === "exit") {
        exitCode = event.code;
        result = execOperationResult({
          stdout: decodeBase64(event.stdout, "stdout"),
          stderr: decodeBase64(event.stderr, "stderr"),
          exitCode: event.code,
          originalBytes:
            event.stdoutBytes === undefined || event.stderrBytes === undefined
              ? undefined
              : { stdout: event.stdoutBytes, stderr: event.stderrBytes },
        });
      }
    }

    return {
      now: Date.now(),
      lines: lines + log.length,
      requests,
      result,
      exitCode,
      yielded,
      replayed,
    };
  };

  const abort = async (
    dir: string,
    reason: string,
    timedOut = false,
  ): Promise<never> => {
    await host.run(sdkStep(`${id}:abort`, "Stop command"), async () => {
      await sandbox.commands.run([
        "/bin/sh",
        "-c",
        'tree() { echo $1; for c in $(pgrep -P $1); do tree $c; done; }; kill -9 $(tree "$(cat "$1/pid")"); rm -f "$1.journal"',
        "sh",
        dir,
      ]);

      return { reason };
    });

    // A timeout is the same failure as the exec timing out, so `$` reports it
    // as one.
    throw timedOut
      ? new SandboxError({
          action: "exec",
          code: "sandbox_exec_timed_out",
          message: reason,
        })
      : new Error(reason);
  };

  let segment = 0;

  /**
   * The result of a replay that made fewer calls than the run it replays: exit
   * 76, with the output the command had (already within the output limit).
   */
  const diverged = (
    result: SandboxOperationResultV1,
  ): SandboxOperationResultV1 => {
    const wire = (
      result as {
        result: {
          stdout: string;
          stderr: string;
          encoding: "utf8" | "base64";
          output?: {
            truncated?: boolean;
            originalBytes: { stdout: number; stderr: number };
          };
        };
      }
    ).result;
    const bytes = (text: string) => {
      return wire.encoding === "utf8"
        ? new TextEncoder().encode(text)
        : decodeBase64(text, "output");
    };
    const note = new TextEncoder().encode(
      "inngest: replay diverged: the script made fewer calls than the first run\n",
    );
    const stderr = bytes(wire.stderr);
    const fitted = execOperationResult({
      stdout: bytes(wire.stdout),
      stderr: new Uint8Array([...stderr, ...note]),
      exitCode: 76,
    }) as { result: { output?: object } };

    // The output was already cut once: keep saying how much there was
    return wire.output?.truncated
      ? ({
          ...fitted,
          result: {
            ...fitted.result,
            output: {
              ...fitted.result.output,
              truncated: true,
              originalBytes: {
                stdout: wire.output.originalBytes.stdout,
                stderr: wire.output.originalBytes.stderr + note.length,
              },
            },
          },
        } as unknown as SandboxOperationResultV1)
      : (fitted as unknown as SandboxOperationResultV1);
  };

  /**
   * Best effort: the stub deletes the journal once it has read it, so this is
   * for a process that ended before it did.
   */
  const removeJournal = (dir: string): Promise<void> => {
    return host.run(sdkStep(`${id}:journal`, "Remove files"), async () => {
      try {
        await sandbox.commands.run(["rm", "-f", `${dir}.journal`]);
      } catch {}
    });
  };

  const answer = async ({
    request: call,
    line,
  }: {
    request: ToolRequest;
    line: string;
  }): Promise<Reply> => {
    const stepId = `${segment === 0 ? id : `${id}:r${segment}`}:tool:${call.tool}:${call.id}`;
    const idempotencyKey = `${scope}${stepId}`;

    try {
      const resolved = await Promise.race([
        resolveToolCall(tools, call, line),
        timeoutAfter(toolTimeoutMs, call.tool),
      ]);
      if (resolved.error !== undefined) {
        return replyLine(call.id, { error: resolved.error });
      }

      if (resolved.group) {
        // The body's own steps are the durable part, so there is no step here.
        const value = await withSpan(
          {
            ...toolSpan(stepId, resolved.displayName ?? call.tool),
            origin: undefined,
          },
          () => {
            return withStepIdPrefix(`${stepId}:`, () => {
              return resolved.invoke({
                signal: new AbortController().signal,
                idempotencyKey,
                runId: host.runId,
              });
            });
          },
        );

        return resultLine(call.id, call.tool, value);
      }

      if (resolved.memo === "none") {
        // Runs inside the wait step: a replay of a finished wait never calls
        // it again, but a retry of that step does, so it must be safe to repeat
        // (the idempotency key is stable across retries).
        return async () => {
          try {
            const signal = AbortSignal.timeout(toolTimeoutMs);
            const value = await Promise.race([
              resolved.invoke({
                signal,
                idempotencyKey,
                runId: host.runId,
                sandbox,
              }),
              timeoutAfter(toolTimeoutMs, call.tool, signal),
            ]);

            return resultLine(call.id, call.tool, value);
          } catch (error) {
            return replyLine(call.id, { error: errorMessage(error) });
          }
        };
      }

      return await host.run(
        {
          id: stepId,
          name: resolved.displayName ?? call.tool,
          "~origin": sdkOrigin,
          "~span": toolSpan(stepId, resolved.displayName ?? call.tool),
        },
        async () => {
          const signal = AbortSignal.timeout(toolTimeoutMs);
          const value = await Promise.race([
            resolved.invoke({
              signal,
              idempotencyKey,
              runId: host.runId,
              sandbox,
            }),
            timeoutAfter(toolTimeoutMs, call.tool, signal),
          ]);

          return resultLine(call.id, call.tool, value);
        },
      );
    } catch (error) {
      return replyLine(call.id, { error: errorMessage(error) });
    }
  };

  /**
   * Starts the process, with `journal` (the replies to replay) if it has any.
   */
  const launch = (
    stepOptions: StepOptionsOrId,
    journal: string[],
    stepMeta: SandboxTraceMetadata,
  ) => {
    return host.run(
      stepOptions,
      async () => {
        const startedAt = Date.now();
        // The step's own ID, which stays distinct when a command ID repeats.
        const stepId =
          getAsyncCtxSync()?.execution?.executingStep?.id ??
          getStepOptions(stepOptions).id;
        const dir = `${toolsRoot}/${sha256().update(`${scope}${stepId}`).digest("hex")}`;
        const journalPath = `${dir}.journal`;
        if (binary) {
        }

        if (journal.length > 0) {
          await sandbox.files.upload({
            path: journalPath,
            data: `${journal.join("\n")}\n`,
          });
        }

        // The wait doesn't need the process to exist yet, so it runs alongside.
        const [, round] = await Promise.all([
          sandbox.processes.start({
            command: ["/bin/sh", "-c", wrapperScript, "sh", dir, ...command],
            ...((environment || journal.length > 0) && {
              environment: {
                ...environment,
                ...(journal.length > 0 && {
                  INNGEST_TOOLS_JOURNAL: journalPath,
                }),
              },
            }),
            ...(cwd !== undefined && { cwd }),
          }),
          follow(dir, 0, [], Math.min(waitWindowMs, timeoutMs)),
        ]);

        return { ...round, startedAt, dir };
      },
      stepMeta,
    );
  };

  const started = await launch(idOrOptions, [], meta);

  let { dir, startedAt } = started;
  let seen = new Set<number>();
  let state: Round = started;
  let waits = 0;
  let calls = 0;
  // The reply to every call answered so far, in call order
  const journal: string[] = [];
  // The call to a tool that waits, once the process has been told to exit
  let suspended: { request: ToolRequest; line: string } | undefined;
  // Whether the stub confirmed it exited to suspend, not on its own
  let yielded = false;
  // Whether this segment's stub said it used the whole journal
  let replayed = false;

  for (;;) {
    yielded ||= state.yielded === true;
    replayed ||= state.replayed === true;

    if (state.result && suspended && yielded && state.exitCode === 75) {
      const reply = await answer(suspended);

      journal.push(
        journaled(
          typeof reply === "function" ? await reply() : reply,
          suspended.request,
        ),
      );
      yielded = false;
      replayed = false;
      segment += 1;
      suspended = undefined;
      seen = new Set();
      const resumed = await launch(
        sdkStep(
          `${id}:resume:${segment}`,
          runningNames[commandKind(operationCommand)],
        ),
        journal,
        { ...meta, kind: "wait" },
      );

      state = resumed;
      dir = resumed.dir;
      startedAt = resumed.startedAt;

      continue;
    }

    if (state.result) {
      if (segment === 0) {
        return state.result;
      }

      try {
        // A replay that exits 0 before using the whole journal made fewer
        // calls than the run it replays
        return state.exitCode === 0 && !replayed
          ? diverged(state.result)
          : state.result;
      } finally {
        await removeJournal(dir);
      }
    }

    if (state.now - startedAt > timeoutMs) {
      return abort(
        dir,
        `Command with tools exceeded its ${timeoutMs}ms timeout`,
        true,
      );
    }

    const pending: Round["requests"] = [];
    for (const { request, line } of [...state.requests].sort((a, b) => {
      return a.request.id - b.request.id;
    })) {
      if (seen.has(request.id) || suspended) {
        continue;
      }

      seen.add(request.id);
      pending.push({ request, line });
    }

    // Calls after one that waits are dropped: the code asks for them again
    // when it runs again.
    const waiting = pending.findIndex(({ request }) => {
      return callWaits(tools, request.tool);
    });
    const answerable = waiting < 0 ? pending : pending.slice(0, waiting);

    // Calls dropped after a waiting one are counted when they are made again
    calls += answerable.length + (waiting < 0 ? 0 : 1);

    if (calls > maxCalls) {
      return abort(dir, `Command made more than ${maxCalls} tool calls`);
    }

    const replies: Reply[] = [];
    for (let at = 0; at < answerable.length; at += maxConcurrentCalls) {
      replies.push(
        ...(await Promise.all(
          answerable.slice(at, at + maxConcurrentCalls).map(answer),
        )),
      );
    }

    const waited = waiting < 0 ? undefined : pending[waiting];
    if (waited) {
      suspended = waited;
      replies.push(
        JSON.stringify({ op: "reply", id: waited.request.id, yield: true }),
      );
    }

    const { lines } = state;
    // What the wait step made, when it ran in this pass. Kept out of the step's
    // output, since a lazy reply must not be stored.
    let made: string[] | undefined;
    const settle = async (): Promise<string[]> => {
      const settled: string[] = [];
      for (let at = 0; at < replies.length; at += maxConcurrentCalls) {
        settled.push(
          ...(await Promise.all(
            replies.slice(at, at + maxConcurrentCalls).map((reply) => {
              return typeof reply === "function" ? reply() : reply;
            }),
          )),
        );
      }

      made = settled;

      return settled;
    };
    const remainingMs = timeoutMs - (state.now - startedAt);
    state = await host.run(
      sdkStep(
        `${id}:wait:${++waits}`,
        runningNames[commandKind(operationCommand)],
      ),
      async () => {
        return follow(
          dir,
          lines,
          await settle(),
          Math.min(waitWindowMs, remainingMs),
        );
      },
      { ...meta, kind: "wait" },
    );

    // A wait step that was already stored didn't run, so a lazy reply is made
    // again here, which it is safe to do
    for (const [at, { request }] of answerable.entries()) {
      const reply = replies[at] as Reply;

      journal.push(
        journaled(
          made?.[at] ?? (typeof reply === "function" ? await reply() : reply),
          request,
        ),
      );
    }
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
