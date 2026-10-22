/**
 * @module
 * A command that may run longer than one step can wait (over five minutes):
 * it starts as a process, steps wait on it in bounded windows, and one step
 * reads its output and decides whether the exit is allowed. The steps are
 * states of one `$` row in the trace, and their IDs end in ` #wait-1`,
 * ` #output` and so on, which the SDK's own `:1` repeat numbers never do.
 */

import type { StepOptionsOrId } from "../../types.ts";
import { getStepOptions, withSpan } from "../InngestStepTools.ts";
import { checkExit, commandFailure, formatTimeout } from "./commandError.ts";
import {
  parseSandboxOperationForAction,
  type SandboxOperationForAction,
  type SandboxResultForAction,
} from "./protocol.ts";
import { commandSpan, sdkOrigin } from "./trace.ts";
import {
  type SandboxAction,
  type SandboxCommandResult,
  type SandboxExitCodes,
  type SandboxProcessRef,
  type SandboxRef,
  sandboxProtocolVersion,
} from "./types.ts";
import {
  decodeOutputChunk,
  decodeUtf8,
  normalizeSandboxProcessStartOptions,
} from "./validation.ts";

/**
 * Runs an operation as a step; with `finish`, the step's output is what
 * `finish` returns. This is `callRawTool`, which this file cannot import.
 */
export type CallOperation = <
  A extends SandboxAction,
  T = SandboxResultForAction<A>,
>(
  idOrOptions: StepOptionsOrId,
  operation: SandboxOperationForAction<A>,
  finish?: (result: SandboxResultForAction<A>) => T | Promise<T>,
) => Promise<T>;

/**
 * How long each wait step follows the process for.
 */
const waitWindowMs = 30_000;

/**
 * The most output the server returns for a process, which is a limit of its
 * protocol.
 */
const outputTailBytes = 512 * 1024;

const sigterm = 15;

const isRunning = (process: { state: string }): boolean => {
  return process.state === "STARTING" || process.state === "RUNNING";
};

/**
 * The exit code of a process that has ended. A process stopped by a signal
 * reports as a shell does, and one that never ran to an exit as -1.
 */
const exitCodeOf = (process: {
  exitCode?: number | undefined;
  terminationSignal?: number | undefined;
}): number => {
  if (process.exitCode !== undefined) {
    return process.exitCode;
  }

  return process.terminationSignal === undefined
    ? -1
    : 128 + process.terminationSignal;
};

const collect = (
  chunks: readonly unknown[],
): {
  stdout: string;
  stderr: string;
  sizes: { stdout: number; stderr: number };
} => {
  const streams = { STDOUT: [] as Uint8Array[], STDERR: [] as Uint8Array[] };
  const sizes = { stdout: 0, stderr: 0 };

  for (const chunk of chunks) {
    const { stream, data } = decodeOutputChunk(chunk);

    streams[stream].push(data);
    sizes[stream === "STDOUT" ? "stdout" : "stderr"] += data.byteLength;
  }

  const text = (parts: Uint8Array[]): string => {
    const joined = new Uint8Array(
      parts.reduce((sum, part) => {
        return sum + part.byteLength;
      }, 0),
    );
    let offset = 0;

    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }

    return decodeUtf8(joined);
  };

  return {
    stdout: text(streams.STDOUT),
    stderr: text(streams.STDERR),
    sizes,
  };
};

export const runManagedCommand = async (opts: {
  call: CallOperation;
  sandbox: SandboxRef;
  /**
   * The step options of the command, which the process's start step has.
   */
  idOrOptions: StepOptionsOrId;
  /**
   * What starts the process.
   */
  spec: Parameters<typeof normalizeSandboxProcessStartOptions>[0];
  /**
   * The command as an error shows it.
   */
  text: string;
  timeoutMs: number;
  exitCodes: SandboxExitCodes;
}): Promise<SandboxCommandResult> => {
  const { call, sandbox, idOrOptions, text, timeoutMs, exitCodes } = opts;
  const step = getStepOptions(idOrOptions);
  const later = (suffix: string, name: string): StepOptionsOrId => {
    return { ...step, id: `${step.id} ${suffix}`, name, "~origin": sdkOrigin };
  };
  const startOperation = parseSandboxOperationForAction("process.start", {
    protocolVersion: sandboxProtocolVersion,
    action: "process.start",
    target: { sandbox },
    input: [normalizeSandboxProcessStartOptions(opts.spec)],
  });
  const span = commandSpan(startOperation, idOrOptions);

  const run = async (): Promise<SandboxCommandResult> => {
    const { process: started } = await call(idOrOptions, startOperation);
    const target = { sandbox, process: started as SandboxProcessRef };
    let current: Parameters<typeof exitCodeOf>[0] & { state: string } = started;
    let elapsed = 0;

    for (let wait = 1; isRunning(current) && elapsed < timeoutMs; wait++) {
      const window = Math.min(waitWindowMs, timeoutMs - elapsed);
      const waited = await call(
        later(`#wait-${wait}`, "Wait for command"),
        parseSandboxOperationForAction("process.wait", {
          protocolVersion: sandboxProtocolVersion,
          action: "process.wait",
          target,
          input: [{ timeoutMs: window, allowRunning: true }],
        }),
      );

      current = waited.process;
      elapsed += window;
    }

    const timedOut = isRunning(current);

    if (timedOut) {
      await call(
        later("#stop", "Stop command"),
        parseSandboxOperationForAction("process.signal", {
          protocolVersion: sandboxProtocolVersion,
          action: "process.signal",
          target,
          input: [{ signal: sigterm, includeChildren: true }],
        }),
      );
    }

    // The one step that decides the outcome, so a failure is a step's failure
    const output = await call(
      later("#output", "Read command output"),
      parseSandboxOperationForAction("process.output", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.output",
        target,
        input: [{ tailBytes: outputTailBytes }],
      }),
      (result) => {
        const { stdout, stderr } = collect(result.result.chunks);

        if (timedOut) {
          throw commandFailure({
            command: text,
            timeout: formatTimeout(timeoutMs),
            stdout,
            stderr,
          });
        }

        checkExit(exitCodes, {
          command: text,
          exitCode: exitCodeOf(current),
          stdout,
          stderr,
        });

        return result;
      },
    );
    const { stdout, stderr, sizes } = collect(output.result.chunks);

    return {
      stdout,
      stderr,
      exitCode: exitCodeOf(current),
      // The server reports no size for what it cut, so a full tail is taken
      // as cut, with the same size on both sides
      output:
        sizes.stdout + sizes.stderr < outputTailBytes
          ? { truncated: false }
          : {
              truncated: true,
              strategy: "tail",
              originalBytes: sizes,
              retainedBytes: sizes,
            },
    };
  };

  return span ? withSpan(span, run) : run();
};
