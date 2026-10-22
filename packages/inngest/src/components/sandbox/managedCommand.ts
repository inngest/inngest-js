/**
 * @module
 * A command that may run longer than one step can wait (over five minutes):
 * it starts as a process, steps wait on it in bounded windows, and one step
 * reads its output and decides whether the exit is allowed. The steps are
 * states of one `$` row in the trace, and their IDs end in ` #wait-1`,
 * ` #output` and so on, which the SDK's own `:1` repeat numbers never do.
 * Its output is a tail of at most 512 KiB (the `tailBytes` limit); the docs describe it as one budget across both streams, which the SDK does not enforce.
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
  maxSandboxProcessTailBytes,
  maxSandboxProcessTimeoutMs,
  normalizeSandboxProcessStartOptions,
} from "./validation.ts";

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
  return (
    process.exitCode ??
    (process.terminationSignal === undefined
      ? undefined
      : 128 + process.terminationSignal)
  );
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
    let current: Ended = started;
    let elapsed = 0;

    for (let wait = 1; isRunning(current) && elapsed < timeoutMs; wait++) {
      // Each wait is the most the protocol allows, so a long timeout takes few
      const windowMs = Math.min(
        maxSandboxProcessTimeoutMs,
        timeoutMs - elapsed,
      );
      const waited = await callRawTool(
        rawToolResolver,
        later(`#wait-${wait}`, "Wait for command"),
        waitOperation(windowMs),
      );

      current = waited.process;
      elapsed += windowMs;
    }

    const timedOut = isRunning(current);

    if (timedOut) {
      await callRawTool(
        rawToolResolver,
        later("#stop", "Stop command"),
        parseSandboxOperationForAction("process.signal", {
          protocolVersion: sandboxProtocolVersion,
          action: "process.signal",
          target,
          input: [{ signal: 9, includeChildren: true }],
        }),
      );
    }

    // The result of this command, or the throw of its failure
    const settle = (chunks: readonly unknown[]): SandboxCommandResult => {
      const { stdout, stderr, sizes } = collect(chunks);
      const failure = { command: text, stdout, stderr };

      if (timedOut) {
        throw commandFailure({
          ...failure,
          type: "timeout",
          reason: `timed out after ${formatTimeout(timeoutMs)} and was killed`,
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

      return {
        stdout,
        stderr,
        exitCode,
        // The server reports no size for what it cut, so a full tail is taken
        // as cut, and only what was kept is known
        output:
          sizes.stdout + sizes.stderr < maxSandboxProcessTailBytes
            ? { truncated: false }
            : { truncated: true, strategy: "tail", retainedBytes: sizes },
      };
    };

    // The one step that decides the outcome, so a failure is a step's failure
    return callRawTool(
      rawToolResolver,
      later("#output", "Read command output"),
      parseSandboxOperationForAction("process.output", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.output",
        target,
        input: [{ tailBytes: maxSandboxProcessTailBytes }],
      }),
      (result) => {
        return settle(result.result.chunks);
      },
    );
  };

  return span ? withSpan(span, run) : run();
};
