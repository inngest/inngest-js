/**
 * @module
 * EXPERIMENTAL: Runs a sandbox command whose code can call tools.
 *
 * The first step starts the process and returns as soon as it exits or makes
 * its first request, so a command that never calls a tool is one step, the
 * same as a plain `commands.run`. From then on each round is:
 *
 * 1. One step per request (`<id>:tool:<name>:<seq>`) runs the tool and returns
 *    just the reply body, so a tool is memoized the moment it returns.
 * 2. One wait step (`<id>:wait:<n>`) uploads those replies (same bytes to the
 *    same path, so a retry is harmless), then blocks inside the sandbox until
 *    the request log grows, the process exits, or the wait window ends.
 *
 * The wait window is a ceiling, not a delay: it ends the moment there is news.
 * A quiet stretch longer than the window continues in a fresh wait step.
 *
 * Requests go to an append-only log read by byte offset, so output is never
 * re-read, and user output stays on stdout and stderr.
 */

import type { StepOptions, StepOptionsOrId } from "../../types.ts";
import { getStepOptions } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { fitDurableSandboxExecOutput, sdkOrigin } from "./durable.ts";
import type {
  SandboxOperationForAction,
  SandboxToolsRequest,
} from "./protocol.ts";
import { toolsRunsRoot, waiterScript, wrapperScript } from "./toolStubs.ts";
import {
  invokeTool,
  maxToolReplyBytes,
  parseToolRequest,
  resolveToolCall,
  type ToolRequest,
  validateTools,
} from "./tools.ts";
import { type SandboxTraceMetadata, sandboxTraceMetadata } from "./trace.ts";
import {
  type Sandbox,
  type SandboxCommandOutputMetadata,
  type SandboxCommandResult,
  type SandboxOutputChunk,
  type SandboxProcess,
  SandboxValidationError,
} from "./types.ts";
import {
  decodeBase64,
  decodeUtf8,
  encodeBase64,
  maxSandboxProcessTimeoutMs,
  normalizeDurationMs,
} from "./validation.ts";

export const defaultWaitWindowMs = 20_000;

export const defaultToolTimeoutMs = 30_000;

export const defaultMaxCalls = 100;

export const maxConcurrentCalls = 8;

const maxWaitWindowMs = 120_000;

const textEncoder = new TextEncoder();

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
  getSandbox: (sandboxId: string) => Promise<Sandbox>;

  /**
   * Scopes idempotency keys to the run.
   */
  runId?: string;
}

interface WaitResult {
  /**
   * Epoch ms when the step finished, for the run's wall-clock timeout.
   */
  now: number;

  /**
   * Bytes of the request log consumed so far.
   */
  offset: number;

  /**
   * Complete lines of the request log that are new.
   */
  requests: string[];

  exit?: {
    stdout: string;
    stderr: string;
    exitCode: number;
    output: SandboxCommandOutputMetadata;
  };
}

interface StartResult extends WaitResult {
  processId: string;
  dir: string;
  startedAt: number;
}

interface Reply {
  seq: number;
  body: string;
}

const isTerminal = (state: string): boolean => {
  return !["STARTING", "RUNNING"].includes(state);
};

const errorMessage = (error: unknown): string => {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
};

const replyBody = (value: unknown): string => {
  return JSON.stringify({ result: value === undefined ? null : value });
};

const errorBody = (message: string): string => {
  return JSON.stringify({ error: message });
};

const byteLength = (text: string): number => {
  return textEncoder.encode(text).byteLength;
};

const joinStream = (
  chunks: SandboxOutputChunk[],
  stream: "STDOUT" | "STDERR",
): Uint8Array => {
  const parts = chunks
    .filter((chunk) => {
      return chunk.stream === stream;
    })
    .map((chunk) => {
      return chunk.data;
    });
  const joined = new Uint8Array(
    parts.reduce((sum, part) => {
      return sum + part.byteLength;
    }, 0),
  );

  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }

  return joined;
};

const toolsRequestOptions = (
  request: SandboxToolsRequest,
): {
  waitWindowMs: number;
  toolTimeoutMs: number;
  maxCalls: number;
  concurrency: number;
} => {
  const options = request.toolOptions ?? {};
  const integerOption = (
    value: number | undefined,
    fallback: number,
    max: number,
    name: string,
  ): number => {
    const chosen = value ?? fallback;
    if (!Number.isInteger(chosen) || chosen < 1 || chosen > max) {
      throw new SandboxValidationError(
        `toolOptions.${name} must be a whole number from 1 to ${max}`,
      );
    }

    return chosen;
  };

  return {
    waitWindowMs:
      options.waitWindow === undefined
        ? defaultWaitWindowMs
        : normalizeDurationMs(
            options.waitWindow,
            maxWaitWindowMs,
            "toolOptions.waitWindow",
          ),
    toolTimeoutMs:
      options.toolTimeout === undefined
        ? defaultToolTimeoutMs
        : normalizeDurationMs(
            options.toolTimeout,
            maxSandboxProcessTimeoutMs,
            "toolOptions.toolTimeout",
          ),
    maxCalls: integerOption(
      options.maxCalls,
      defaultMaxCalls,
      10_000,
      "maxCalls",
    ),
    concurrency: integerOption(
      options.concurrency,
      maxConcurrentCalls,
      maxConcurrentCalls,
      "concurrency",
    ),
  };
};

/**
 * Runs `operation` (a `commands.run` call) with `request.tools` available to
 * the code it runs.
 */
export const runCommandWithTools = async (
  host: ToolsHost,
  idOrOptions: StepOptionsOrId,
  operation: SandboxOperationForAction<"exec">,
  request: SandboxToolsRequest,
): Promise<SandboxCommandResult> => {
  validateTools(request.tools);

  const { id } = getStepOptions(idOrOptions);
  const options = toolsRequestOptions(request);
  const [{ command, environment, cwd, timeoutMs }] = operation.input;
  const sandboxId = operation.target.sandbox.id;
  const meta = sandboxTraceMetadata(operation, { error: undefined });

  const sdkStep = (stepId: string, name: string): StepOptions => {
    return { id: stepId, name, "~origin": sdkOrigin };
  };

  const finish = async (
    sandbox: Sandbox,
    processId: string,
    offset: number,
    known?: SandboxProcess,
  ): Promise<WaitResult> => {
    const process = known ?? (await sandbox.processes.get(processId));
    if (!process) {
      throw new Error(`Process ${processId} not found`);
    }

    const ended = await process.wait({ timeout: "30s" });
    const output = await ended.getOutput();
    const fitted = fitDurableSandboxExecOutput(
      joinStream(output.chunks, "STDOUT"),
      joinStream(output.chunks, "STDERR"),
    );

    return {
      now: Date.now(),
      offset,
      requests: [],
      exit: {
        stdout: encodeBase64(fitted.stdout),
        stderr: encodeBase64(fitted.stderr),
        exitCode: ended.exitCode ?? -1,
        output: fitted.output,
      },
    };
  };

  /**
   * Uploads replies while waiting for news, since the code can't ask for
   * anything new until it has its reply. Everything after a process starts
   * must not be retried by the first step, since a retry would start another.
   */
  const waitForNews = async (
    sandbox: Sandbox,
    processId: string,
    dir: string,
    from: { offset: number; replies: Reply[]; windowMs: number },
    known?: SandboxProcess,
  ): Promise<WaitResult> => {
    const follow = async (): Promise<WaitResult> => {
      let offset = from.offset;

      const deadline = Date.now() + from.windowMs;

      for (;;) {
        const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        const waited = await sandbox.commands.run(
          ["/bin/sh", "-c", waiterScript, "sh", dir, `${offset}`, `${seconds}`],
          { timeout: (seconds + 30) * 1000 },
        );
        const [header = "", ...rest] = waited.stdout.split("\n");
        const chunk = rest.join("\n");
        const complete = chunk.slice(0, chunk.lastIndexOf("\n") + 1);

        offset += byteLength(complete);

        const requests = complete.split("\n").filter((line) => {
          return line !== "";
        });
        if (header === "exit=1") {
          return finish(sandbox, processId, offset, known);
        }

        if (requests.length > 0) {
          return { now: Date.now(), offset, requests };
        }

        if (Date.now() >= deadline) {
          const process = await sandbox.processes.get(processId);
          if (process && isTerminal(process.state)) {
            return finish(sandbox, processId, offset, known);
          }

          return { now: Date.now(), offset, requests };
        }
      }
    };
    const uploads = Promise.all(
      from.replies.map((reply) => {
        return sandbox.files.upload({
          path: `${dir}/${reply.seq}.json`,
          data: reply.body,
        });
      }),
    );
    const [, news] = await Promise.all([uploads, follow()]);

    return news;
  };

  const abort = async (processId: string, reason: string): Promise<never> => {
    await host.run(sdkStep(`${id}:abort`, "Stop command"), async () => {
      const sandbox = await host.getSandbox(sandboxId);
      const process = await sandbox.processes.get(processId);

      await process?.signal({ signal: 9 });

      return { reason };
    });

    throw new Error(reason);
  };

  const started = await host.run(
    idOrOptions,
    async (): Promise<StartResult> => {
      const sandbox = await host.getSandbox(sandboxId);
      const dir = `${toolsRunsRoot}/${crypto.randomUUID()}`;
      const process = await sandbox.processes.start({
        command: ["/bin/sh", "-c", wrapperScript, "sh", ...command],
        environment: {
          ...environment,
          INNGEST_TOOLS_DIR: dir,
          INNGEST_TOOLS_TIMEOUT: `${Math.ceil(timeoutMs / 1000)}`,
        },
        ...(cwd !== undefined && { cwd }),
      });
      const startedAt = Date.now();

      try {
        const news = await waitForNews(
          sandbox,
          process.id,
          dir,
          { offset: 0, replies: [], windowMs: options.waitWindowMs },
          process,
        );

        return { ...news, processId: process.id, dir, startedAt };
      } catch (error) {
        throw new NonRetriableError(
          `Command started but could not be followed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    },
    meta,
  );

  const seen = new Set<number>();
  const queue: { request: ToolRequest; line: string }[] = [];

  let state: WaitResult = started;
  let calls = 0;
  let round = 0;

  for (;;) {
    if (state.exit) {
      return {
        stdout: decodeUtf8(decodeBase64(state.exit.stdout, "stdout")),
        stderr: decodeUtf8(decodeBase64(state.exit.stderr, "stderr")),
        exitCode: state.exit.exitCode,
        output: state.exit.output,
      };
    }

    if (state.now - started.startedAt > timeoutMs) {
      return abort(
        started.processId,
        `Command with tools exceeded its ${timeoutMs}ms timeout`,
      );
    }

    for (const line of state.requests) {
      const parsed = parseToolRequest(line);
      if (!parsed || seen.has(parsed.seq)) {
        continue;
      }

      seen.add(parsed.seq);
      calls++;

      if (calls > options.maxCalls) {
        return abort(
          started.processId,
          `Command made more than ${options.maxCalls} tool calls`,
        );
      }

      queue.push({ request: parsed, line });
    }

    const batch = queue.splice(0, options.concurrency);
    const replies = await Promise.all(
      batch.map(async ({ request: call, line }): Promise<Reply> => {
        const resolved = await resolveToolCall(request.tools, call, line);
        if (!resolved.ok) {
          return { seq: call.seq, body: errorBody(resolved.error) };
        }

        const stepId = `${id}:tool:${call.tool}:${call.seq}`;

        try {
          const body = await host.run(
            { id: stepId, name: `tool ${call.tool}` },
            async () => {
              const controller = new AbortController();
              const timer = setTimeout(() => {
                controller.abort();
              }, options.toolTimeoutMs);

              try {
                const value = await Promise.race([
                  invokeTool(resolved, {
                    signal: controller.signal,
                    idempotencyKey: `${host.runId ?? ""}:${stepId}`,
                  }),
                  new Promise<never>((_, reject) => {
                    controller.signal.addEventListener("abort", () => {
                      reject(
                        new Error(
                          `${call.tool} timed out after ${options.toolTimeoutMs}ms`,
                        ),
                      );
                    });
                  }),
                ]);
                const text = replyBody(value);

                if (byteLength(text) > maxToolReplyBytes) {
                  throw new NonRetriableError(
                    `${call.tool} returned more than ${maxToolReplyBytes} bytes; write large data to a file instead`,
                  );
                }

                return text;
              } finally {
                clearTimeout(timer);
              }
            },
          );

          return { seq: call.seq, body };
        } catch (error) {
          return { seq: call.seq, body: errorBody(errorMessage(error)) };
        }
      }),
    );

    round++;
    const { offset } = state;
    state = await host.run(
      sdkStep(`${id}:wait:${round}`, "Wait for tool calls"),
      async () => {
        const sandbox = await host.getSandbox(sandboxId);

        return waitForNews(sandbox, started.processId, started.dir, {
          offset,
          replies,
          windowMs: queue.length > 0 ? 0 : options.waitWindowMs,
        });
      },
      { ...meta, kind: "wait" },
    );
  }
};
