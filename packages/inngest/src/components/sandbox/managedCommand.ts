/**
 * @module
 * A command that may run longer than one step can wait (over five minutes):
 * it starts as a process, steps wait on it in bounded windows, and one step
 * reads its output and decides whether the exit is allowed. The steps are
 * states of one `/**
 * @module
 * A command that may run longer than one step can wait (over five minutes):
 * it starts as a process, steps wait on it in bounded windows, and one step
 * reads its output and decides whether the exit is allowed. The steps are
 row in the trace, and their IDs end in ` #wait-1`,
 * ` #output` and so on, which the SDK's own `:1` repeat numbers never do.
 * Its output is the 512 KiB tail the server keeps, where a command that fits
 * in one step fails on output that is too large.
 */

import type { StepOptionsOrId } from "../../types.ts";
import { getStepOptions, withSpan } from "../InngestStepTools.ts";
import { callRawTool } from "./callRawTool.ts";
import { checkExit, commandFailure, formatTimeout } from "./commandError.ts";
import {
  parseSandboxOperationForAction,
  type SandboxRawToolResolver,
} from "./protocol.ts";
import { commandSpan, sdkOrigin } from "./trace.ts";
import {
  type SandboxCommandResult,
  type SandboxExitCodes,
  type SandboxProcessRef,
  type SandboxRef,
  sandboxProtocolVersion,
} from "./types.ts";
import {
  decodeOutputChunk,
  decodeUtf8,
  maxSandboxProcessTimeoutMs,
  normalizeSandboxProcessStartOptions,
} from "./validation.ts";

/**
 * How long each wait step follows the process for: the most the protocol
 * allows, so a long timeout takes few steps.
 */
const waitWindowMs = maxSandboxProcessTimeoutMs;

/**
 * How long a process gets to exit after SIGTERM before it is killed.
 */
const stopWindowMs = 5_000;

/**
 * The most output the server returns for a process, which is a limit of its
 * protocol.
 */
const outputTailBytes = 512 * 1024;

const sigterm = 15;
const sigkill = 9;

/**
 * What a wait reports of a process.
 */
type Ended = {
  state: string;
  exitCode?: number | undefined;
  terminationSignal?: number | undefined;
};

const isRunning = (process: Ended): boolean => {
  return process.state === "STARTING" || process.state === "RUNNING";
};

/**
 * The exit code of a process that has ended: its own, or for one stopped by a
 * signal what a shell reports. A process that ended without either (LOST or
 * FAILED) has none.
 */
const exitCodeOf = (process: Ended): number | undefined => {
  if (process.exitCode !== undefined) {
    return process.exitCode;
  }

  return process.terminationSignal === undefined
    ? undefined
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
  rawToolResolver: SandboxRawToolResolver;
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
  const { rawToolResolver, sandbox, idOrOptions, text, timeoutMs, exitCodes } =
    opts;
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
    const { process: started } = await callRawTool(
      rawToolResolver,
      idOrOptions,
      startOperation,
    );
    const target = { sandbox, process: started as SandboxProcessRef };
    const waitOperation = (windowMs: number) => {
      return parseSandboxOperationForAction("process.wait", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.wait",
        target,
        input: [{ timeoutMs: windowMs, allowRunning: true }],
      });
    };
    const signalOperation = (signal: number) => {
      return parseSandboxOperationForAction("process.signal", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.signal",
        target,
        input: [{ signal, includeChildren: true }],
      });
    };
    let current: Ended = started;
    let elapsed = 0;

    for (let wait = 1; isRunning(current) && elapsed < timeoutMs; wait++) {
      const windowMs = Math.min(waitWindowMs, timeoutMs - elapsed);
      const waited = await callRawTool(
        rawToolResolver,
        later(`#wait-${wait}`, "Wait for command"),
        waitOperation(windowMs),
      );

      current = waited.process;
      elapsed += windowMs;
    }

    // How a command that outlived its timeout ended, for the error's message
    let stopped: string | undefined;

    if (isRunning(current)) {
      await callRawTool(
        rawToolResolver,
        later("#stop", "Stop command"),
        signalOperation(sigterm),
      );

      const waited = await callRawTool(
        rawToolResolver,
        later("#stop-wait", "Wait for command to stop"),
        waitOperation(stopWindowMs),
      );

      if (isRunning(waited.process)) {
        await callRawTool(
          rawToolResolver,
          later("#kill", "Kill command"),
          signalOperation(sigkill),
        );

        stopped = "was killed after it did not stop on SIGTERM";
      } else {
        stopped = "was stopped";
      }
    }

    // Throws the failure of this command, or returns its exit code
    const settle = (stdout: string, stderr: string): number => {
      const failure = { command: text, stdout, stderr };

      if (stopped !== undefined) {
        throw commandFailure({
          ...failure,
          type: "timeout",
          reason: `timed out after ${formatTimeout(timeoutMs)} and ${stopped}`,
        });
      }

      const exitCode = exitCodeOf(current);

      if (exitCode === undefined) {
        throw commandFailure({
          ...failure,
          type: "failed",
          reason: `ended ${current.state}`,
        });
      }

      checkExit(exitCodes, { ...failure, exitCode });

      return exitCode;
    };

    // The one step that decides the outcome, so a failure is a step's failure
    const output = await callRawTool(
      rawToolResolver,
      later("#output", "Read command output"),
      parseSandboxOperationForAction("process.output", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.output",
        target,
        input: [{ tailBytes: outputTailBytes }],
      }),
      (result) => {
        const { stdout, stderr } = collect(result.result.chunks);

        settle(stdout, stderr);

        return result;
      },
    );
    const { stdout, stderr, sizes } = collect(output.result.chunks);

    return {
      stdout,
      stderr,
      exitCode: settle(stdout, stderr),
      // The server reports no size for what it cut, so a full tail is taken
      // as cut, and only what was kept is known
      output:
        sizes.stdout + sizes.stderr < outputTailBytes
          ? { truncated: false }
          : { truncated: true, strategy: "tail", retainedBytes: sizes },
    };
  };

  return span ? withSpan(span, run) : run();
};
