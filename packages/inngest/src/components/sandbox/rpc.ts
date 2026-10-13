/**
 * @module
 * EXPERIMENTAL proof of concept: let code running inside a sandbox call tools
 * that live in the user's app.
 *
 * The sandbox cannot reach the app (sandboxes are egress-only), so calls travel
 * over the channels the Sandboxes API already has:
 *
 * - Sandbox to function: the stub prints `::inngest-rpc::{json}` on stdout.
 * - Function to sandbox: the function uploads `/inngest/rpc/<id>.json`, which
 *   the stub polls for.
 *
 * The function drives a loop of short `step.run` polls. Every request becomes
 * its own `step.run` (`<id>:call:<tool>:<seq>`) that runs the tool and uploads
 * the reply, so a tool call is memoized, retried and traced like any step.
 *
 * Limits worth knowing:
 *
 * - Latency: a reply is only seen when the stub next polls (about 100 ms) and
 *   the function next polls the process output (up to `pollIntervalMs`), plus
 *   the step round trip (tens to hundreds of ms).
 * - Trace noise: every poll window is a step row. Quiet sandboxes still cost
 *   one step per `pollWindowMs`.
 * - Step count: roughly `runtime / pollWindowMs + 2 * calls + 3`. Capped by
 *   `maxPolls` and `maxCalls`.
 * - Step output is capped at 4 MiB and uploads at 1 MiB. Each poll reads at
 *   most 1 MiB of new stdout; replies over 1 MiB are replaced with an error.
 * - Each poll re-reads the whole process output (no offset API yet), so very
 *   chatty processes get slower to poll.
 * - A call step that fails after the tool ran (for example the upload) is
 *   retried, so the tool can run twice. Make tools idempotent.
 * - The stub and the code are untrusted. The host validates tool names (must
 *   be an own key of `tools`), argument shape and size, and computes the reply
 *   path itself from an integer id.
 * - Python only. Calls are synchronous inside the sandbox.
 */
import type { SandboxClient } from "./types.ts";

const requestPrefix = "::inngest-rpc::";

const resultPrefix = "::inngest-result::";

const maxPollReadBytes = 1024 * 1024;

const maxReplyBytes = 1024 * 1024;

const maxRequestBytes = 256 * 1024;

const maxStepResultBytes = 64 * 1024;

const maxStderrBytes = 64 * 1024;

const toolNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const reservedNames = new Set(["RpcError", "result"]);

const textEncoder = new TextEncoder();

const textDecoder = new TextDecoder();

/**
 * The slice of `step` this needs. Pass the `step` from your function context.
 */
export interface RunWithToolsStep {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
}

export interface RunWithToolsOptions<
  TTools extends Record<string, (...args: never[]) => unknown>,
> {
  /**
   * An existing sandbox, for example the one from `step.sandbox.create`.
   */
  sandbox: { id: string };

  /**
   * The direct Sandboxes client, `inngest.sandboxes`. Used inside steps for
   * file uploads and process output, which have no durable facade.
   */
  sandboxes: SandboxClient;

  language: "python";

  /**
   * Source to run. Each tool name is available as a plain function, and
   * `result(value)` sets the returned `result`.
   */
  code: string;

  /**
   * Functions the sandboxed code may call. Arguments and return values must be
   * JSON-serializable.
   */
  tools: TTools;

  /**
   * How long a single poll step waits for news before returning. Default
   * 10000.
   */
  pollWindowMs?: number;

  /**
   * How often a poll step checks the process while waiting. Default 500.
   */
  pollIntervalMs?: number;

  /**
   * Maximum number of poll steps before giving up and killing the process.
   * Default 120.
   */
  maxPolls?: number;

  /**
   * Maximum number of tool calls before giving up and killing the process.
   * Default 100.
   */
  maxCalls?: number;

  /**
   * How long the stub waits for a reply, in seconds. Default 300.
   */
  replyTimeoutSeconds?: number;
}

export interface RunWithToolsCall {
  seq: number;
  tool: string;
  ok: boolean;
  error?: string;
}

export interface RunWithToolsResult {
  /**
   * The last `result(value)` the code set, or `undefined`.
   */
  result: unknown;
  stdout: string;
  stderr: string;
  exitCode: number;
  calls: RunWithToolsCall[];
}

interface RpcRequest {
  id: number;
  tool: string;
  args: unknown[];
}

interface PollOutput {
  out: number;
  err: number;
  lines: string[];
  requests: RpcRequest[];
  results: unknown[];
  stderr: string;
  exited: boolean;
  exitCode: number;
}

interface CallOutput {
  seq: number;
  tool: string;
  ok: boolean;
  error?: string;
  bytes: number;
  result?: unknown;
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
};

const isRequest = (value: unknown): value is RpcRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "number" &&
    Number.isSafeInteger(candidate.id) &&
    candidate.id >= 1 &&
    typeof candidate.tool === "string" &&
    candidate.tool.length <= 128 &&
    Array.isArray(candidate.args)
  );
};

/**
 * Splits new output into complete lines and sorts them into requests, results
 * and plain output. Returns how many bytes were consumed.
 */
const readNewLines = (
  all: Uint8Array,
  offset: number,
  final: boolean,
): {
  consumed: number;
  lines: string[];
  requests: RpcRequest[];
  results: unknown[];
} => {
  const window = all.subarray(offset, offset + maxPollReadBytes);

  let end = window.lastIndexOf(10) + 1;
  if (end === 0 && (final || window.byteLength === maxPollReadBytes)) {
    end = window.byteLength;
  }

  const text = textDecoder.decode(window.subarray(0, end));
  const lines: string[] = [];
  const requests: RpcRequest[] = [];
  const results: unknown[] = [];

  for (const line of text.split("\n")) {
    if (line.startsWith(requestPrefix)) {
      try {
        if (textEncoder.encode(line).byteLength > maxRequestBytes) {
          throw new Error("request too large");
        }

        const parsed: unknown = JSON.parse(line.slice(requestPrefix.length));
        if (isRequest(parsed)) {
          requests.push({
            id: parsed.id,
            tool: parsed.tool,
            args: parsed.args,
          });

          continue;
        }
      } catch {
        // Malformed requests are surfaced as plain output below.
      }
    }

    if (line.startsWith(resultPrefix)) {
      try {
        results.push(JSON.parse(line.slice(resultPrefix.length)));

        continue;
      } catch {
        // Malformed results are surfaced as plain output below.
      }
    }

    if (line !== "") {
      lines.push(line);
    }
  }

  return { consumed: end, lines, requests, results };
};

const streamBytes = (
  chunks: { stream: string; data: Uint8Array }[],
  stream: "STDOUT" | "STDERR",
): Uint8Array => {
  const parts = chunks
    .filter((chunk) => {
      return chunk.stream === stream;
    })
    .map((chunk) => {
      return chunk.data;
    });
  const total = parts.reduce((sum, part) => {
    return sum + part.byteLength;
  }, 0);
  const joined = new Uint8Array(total);

  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }

  return joined;
};

/**
 * Builds the Python stub. Tool names are validated, so embedding them is safe.
 */
export const buildPythonStub = (
  toolNames: string[],
  replyTimeoutSeconds: number,
): string => {
  return `import json
import os
import sys
import time

_DIR = "/inngest/rpc"
_TIMEOUT = ${Math.floor(replyTimeoutSeconds)}
_TOOLS = ${JSON.stringify(toolNames)}
_seq = 0


class RpcError(Exception):
    pass


def _call(tool, args):
    global _seq
    _seq += 1
    n = _seq
    sys.stdout.write("${requestPrefix}" + json.dumps({"id": n, "tool": tool, "args": list(args)}) + "\\n")
    sys.stdout.flush()
    path = "%s/%d.json" % (_DIR, n)
    deadline = time.time() + _TIMEOUT
    while True:
        if os.path.exists(path):
            try:
                with open(path) as f:
                    reply = json.load(f)
                break
            except ValueError:
                pass
        if time.time() > deadline:
            raise RpcError("timed out waiting for the host to answer " + tool)
        time.sleep(0.1)
    if "error" in reply:
        raise RpcError(reply["error"])
    return reply.get("result")


def result(value):
    sys.stdout.write("${resultPrefix}" + json.dumps(value) + "\\n")
    sys.stdout.flush()


def _make(tool):
    def fn(*args):
        return _call(tool, args)
    fn.__name__ = tool
    return fn


exports = {name: _make(name) for name in _TOOLS}
exports["RpcError"] = RpcError
exports["result"] = result
`;
};

const pythonLauncher = `import sys
sys.path.insert(0, "/inngest")
import rpc

with open("/inngest/main.py") as f:
    source = f.read()

scope = dict(rpc.exports)
scope["__name__"] = "__main__"
exec(compile(source, "/inngest/main.py", "exec"), scope)
`;

const validateTools = (tools: Record<string, unknown>): string[] => {
  const names = Object.keys(tools);

  for (const name of names) {
    if (!toolNamePattern.test(name) || reservedNames.has(name)) {
      throw new Error(`Invalid tool name: ${name}`);
    }

    if (typeof tools[name] !== "function") {
      throw new Error(`Tool ${name} is not a function`);
    }
  }

  return names;
};

const oneLine = (error: unknown): string => {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
};

/**
 * EXPERIMENTAL: Runs `code` in an existing sandbox and serves its tool calls
 * from `tools`, each as a durable step.
 *
 * `id` namespaces every step: `<id>:setup`, `<id>:start`, `<id>:poll:<n>` and
 * `<id>:call:<tool>:<seq>`. Use a different `id` for each call in a function.
 *
 * @example
 * ```ts
 * const box = await step.sandbox.create("box", { name: "analyse" });
 *
 * const { result, calls } = await runWithTools(step, "analyse", {
 *   sandbox: box,
 *   sandboxes: inngest.sandboxes,
 *   language: "python",
 *   code: `
 * customer = getCustomer("cus_1")
 * result(customer["plan"])
 * `,
 *   tools: {
 *     getCustomer: async (id: string) => ({ id, plan: "pro" }),
 *   },
 * });
 * ```
 */
export const runWithTools = async <
  TTools extends Record<string, (...args: never[]) => unknown>,
>(
  step: RunWithToolsStep,
  id: string,
  options: RunWithToolsOptions<TTools>,
): Promise<RunWithToolsResult> => {
  const tools: Record<string, unknown> = options.tools;
  const toolNames = validateTools(tools);
  const pollWindowMs = options.pollWindowMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const maxPolls = options.maxPolls ?? 120;
  const maxCalls = options.maxCalls ?? 100;
  const sandboxId = options.sandbox.id;

  const runStep = async <T>(
    stepId: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    return (await step.run(stepId, fn)) as T;
  };

  const getSandbox = async () => {
    const sandbox = await options.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`);
    }

    return sandbox;
  };

  await runStep(`${id}:setup`, async () => {
    const sandbox = await getSandbox();

    await sandbox.commands.run(["/bin/mkdir", "-p", "/inngest/rpc"]);

    await sandbox.files.upload({
      path: "/inngest/rpc.py",
      data: buildPythonStub(toolNames, options.replyTimeoutSeconds ?? 300),
    });

    await sandbox.files.upload({
      path: "/inngest/run.py",
      data: pythonLauncher,
    });

    await sandbox.files.upload({
      path: "/inngest/main.py",
      data: options.code,
    });

    return { toolNames };
  });

  const processId = await runStep(`${id}:start`, async () => {
    const sandbox = await getSandbox();
    const proc = await sandbox.processes.start({
      command: "python3 /inngest/run.py",
      environment: { PYTHONUNBUFFERED: "1" },
    });

    return proc.id;
  });

  const poll = async (
    n: number,
    offsets: { out: number; err: number },
  ): Promise<PollOutput> => {
    return runStep(`${id}:poll:${n}`, async () => {
      const sandbox = await getSandbox();
      const deadline = Date.now() + pollWindowMs;

      for (;;) {
        const proc = await sandbox.processes.get(processId);
        if (!proc) {
          throw new Error(`Process ${processId} not found`);
        }

        const exited = !["STARTING", "RUNNING"].includes(proc.state);
        const output = await proc.getOutput();
        const stdout = streamBytes(output.chunks, "STDOUT");
        const stderr = streamBytes(output.chunks, "STDERR");
        const read = readNewLines(stdout, offsets.out, exited);
        const hasMore = stdout.byteLength > offsets.out + read.consumed;

        if (
          read.requests.length > 0 ||
          exited ||
          hasMore ||
          Date.now() >= deadline
        ) {
          const errBytes = stderr.subarray(
            offsets.err,
            offsets.err + maxStderrBytes,
          );

          return {
            out: offsets.out + read.consumed,
            err: offsets.err + errBytes.byteLength,
            lines: read.lines,
            requests: read.requests,
            results: read.results,
            stderr: textDecoder.decode(errBytes),
            exited: exited && !hasMore,
            exitCode: proc.exitCode ?? (exited ? -1 : 0),
          };
        }

        await sleep(pollIntervalMs);
      }
    });
  };

  const call = async (request: RpcRequest): Promise<CallOutput> => {
    const known = Object.hasOwn(tools, request.tool);
    const stepTool = known ? request.tool : "unknown";

    return runStep(`${id}:call:${stepTool}:${request.id}`, async () => {
      let reply: { result: unknown } | { error: string };

      if (!known) {
        reply = { error: `Unknown tool: ${request.tool.slice(0, 64)}` };
      } else {
        try {
          const fn = tools[request.tool] as (...args: unknown[]) => unknown;
          const value = await fn(...request.args);

          reply = { result: value === undefined ? null : value };
        } catch (error) {
          reply = { error: oneLine(error) };
        }
      }

      let body = JSON.stringify(reply);
      if (textEncoder.encode(body).byteLength > maxReplyBytes) {
        reply = { error: "Tool result exceeds the 1 MiB reply limit" };
        body = JSON.stringify(reply);
      }

      const sandbox = await getSandbox();

      await sandbox.files.upload({
        path: `/inngest/rpc/${request.id}.json`,
        data: body,
      });

      const bytes = textEncoder.encode(body).byteLength;

      return {
        seq: request.id,
        tool: stepTool,
        ok: "result" in reply,
        ...("error" in reply && { error: reply.error }),
        bytes,
        ...("result" in reply &&
          bytes <= maxStepResultBytes && { result: reply.result }),
      };
    });
  };

  const abort = async (reason: string): Promise<never> => {
    await runStep(`${id}:abort`, async () => {
      const sandbox = await getSandbox();
      const proc = await sandbox.processes.get(processId);

      await proc?.signal({ signal: 9 });

      return { reason };
    });

    throw new Error(reason);
  };

  const stdoutLines: string[] = [];
  const stderrParts: string[] = [];
  const calls: RunWithToolsCall[] = [];
  const handled = new Set<number>();

  let results: unknown[] = [];
  let offsets = { out: 0, err: 0 };

  for (let n = 0; n < maxPolls; n++) {
    const polled = await poll(n, offsets);

    offsets = { out: polled.out, err: polled.err };
    stdoutLines.push(...polled.lines);
    results = results.concat(polled.results);
    if (polled.stderr) {
      stderrParts.push(polled.stderr);
    }

    if (polled.exited) {
      return {
        result: results.length > 0 ? results[results.length - 1] : undefined,
        stdout: stdoutLines.join("\n"),
        stderr: stderrParts.join(""),
        exitCode: polled.exitCode,
        calls,
      };
    }

    for (const request of polled.requests) {
      if (handled.has(request.id)) {
        continue;
      }

      if (calls.length >= maxCalls) {
        return abort(`Exceeded maxCalls (${maxCalls})`);
      }

      handled.add(request.id);

      const output = await call(request);

      calls.push({
        seq: output.seq,
        tool: output.tool,
        ok: output.ok,
        ...(output.error !== undefined && { error: output.error }),
      });
    }
  }

  return abort(`Exceeded maxPolls (${maxPolls})`);
};
