import { asyncDispose } from "../../helpers/asyncDispose.ts";
import type { DeferHandle, StepOptionsOrId } from "../../types.ts";
import { getStepOptions, withSpan } from "../InngestStepTools.ts";
import { StepError } from "../StepError.ts";
import { callRawTool } from "./callRawTool.ts";
import {
  type SandboxCleanupRegistrar,
  setCleanupRegistrar,
} from "./cleanup.ts";
import {
  createSandboxForOperation,
  createSandboxSnapshotForOperation,
  deleteSandboxSnapshotForOperation,
  getSandboxSnapshotForOperation,
  listSandboxSnapshotsForOperation,
  runSandboxCommandForOperation,
  sandboxForOperation,
  sandboxProcessForOperation,
  waitUntilSandboxSnapshotReadyForOperation,
} from "./client.ts";
import { codeTools } from "./codeTools.ts";
import { checkExit, commandText } from "./commandError.ts";
import { createDollar } from "./dollar.ts";
import { destroyQuietly } from "./group.ts";
import { runManagedCommand } from "./managedCommand.ts";
import {
  findSandboxErrorOptions,
  findSandboxValidationError,
  maxDurableSandboxExecOutputBytes,
  parseSandboxOperation,
  parseSandboxOperationForAction,
  type SandboxOperationForAction,
  type SandboxOperationResultV1,
  type SandboxOperationV1,
  type SandboxRawToolResolver,
  type SandboxResultForAction,
  validateSandboxResult,
} from "./protocol.ts";
import { createShell } from "./shell.ts";
import { validateShims, withShims } from "./shims.ts";
import { bundledToolBinary } from "./toolBinary.ts";
import type { SandboxToolsRequest } from "./tools.ts";
import { commandSpan, namedStep, sdkOrigin } from "./trace.ts";
import {
  type DurableSandbox,
  type DurableSandboxProcess,
  type DurableSandboxSnapshot,
  type DurableSandboxTools,
  type Sandbox,
  type SandboxAction,
  type SandboxClient,
  type SandboxCommandResult,
  type SandboxDestroyResult,
  SandboxError,
  type SandboxOutputChunk,
  type SandboxProcess,
  type SandboxProcessRef,
  type SandboxRef,
  type SandboxSnapshotRef,
  SandboxValidationError,
  sandboxProtocolVersion,
} from "./types.ts";
import {
  canonicalUuidSchema,
  decodeBase64,
  decodeOutputChunk,
  decodeOutputData,
  decodeUtf8,
  encodeBase64,
  encodeOutput,
  exitCodesSchema,
  maxSandboxProcessTimeoutMs,
  normalizeDurationMs,
  normalizeSandboxCommandOptions,
  normalizeSandboxCreateOptions,
  normalizeSandboxListOptions,
  normalizeSandboxProcessListOptions,
  normalizeSandboxProcessOutputOptions,
  normalizeSandboxProcessSignalOptions,
  normalizeSandboxProcessStartOptions,
  normalizeSandboxProcessWaitOptions,
  normalizeSandboxSnapshotCreateOptions,
  normalizeSandboxSnapshotListOptions,
  normalizeSandboxSnapshotWaitOptions,
  normalizeSandboxWaitUntilRunningOptions,
  parseWithSchema,
  type SandboxOutputEncoding,
  sandboxProcessRefSchema,
  sandboxRefSchema,
  sandboxSnapshotRefSchema,
} from "./validation.ts";

const fitDurableSandboxExecOutput = (
  stdout: Uint8Array,
  stderr: Uint8Array,
): {
  stdout: Uint8Array;
  stderr: Uint8Array;
  output: SandboxResultForAction<"exec">["result"]["output"];
} => {
  const originalBytes = {
    stdout: stdout.byteLength,
    stderr: stderr.byteLength,
  };
  if (
    originalBytes.stdout + originalBytes.stderr <=
    maxDurableSandboxExecOutputBytes
  ) {
    return { stdout, stderr, output: { truncated: false } };
  }

  // This bound intentionally lives in the `step.sandbox.exec` wrapper rather
  // than the direct client. `step.run` persists at most 4 MiB of serialized
  // output, and base64 expands captured bytes. Reserve half of the safe raw
  // budget for each stream, donate unused capacity to the other stream, and
  // retain tails because command failures generally appear at the end.
  const streamShare = Math.floor(maxDurableSandboxExecOutputBytes / 2);
  let retainedStdoutBytes = Math.min(originalBytes.stdout, streamShare);
  let retainedStderrBytes = Math.min(originalBytes.stderr, streamShare);
  let remainingBytes =
    maxDurableSandboxExecOutputBytes -
    retainedStdoutBytes -
    retainedStderrBytes;

  const extraStdoutBytes = Math.min(
    originalBytes.stdout - retainedStdoutBytes,
    remainingBytes,
  );
  retainedStdoutBytes += extraStdoutBytes;
  remainingBytes -= extraStdoutBytes;
  retainedStderrBytes += Math.min(
    originalBytes.stderr - retainedStderrBytes,
    remainingBytes,
  );

  const retainedBytes = {
    stdout: retainedStdoutBytes,
    stderr: retainedStderrBytes,
  };
  return {
    stdout: stdout.subarray(originalBytes.stdout - retainedBytes.stdout),
    stderr: stderr.subarray(originalBytes.stderr - retainedBytes.stderr),
    output: {
      truncated: true,
      strategy: "tail",
      originalBytes,
      retainedBytes,
    },
  };
};

const encodeOutputChunk = (
  chunk: SandboxOutputChunk,
): {
  stream: "STDOUT" | "STDERR";
  data: string;
  encoding: SandboxOutputEncoding;
  at?: string;
} => {
  const {
    encoding,
    values: [data],
  } = encodeOutput([chunk.data]);

  return {
    stream: chunk.stream,
    data: data!,
    encoding,
    ...(chunk.at !== undefined && { at: chunk.at }),
  };
};

const sandboxRefForWire = (sandbox: Sandbox): SandboxRef => ({
  kind: sandbox.kind,
  version: sandbox.version,
  id: sandbox.id,
  name: sandbox.name,
  status: sandbox.status,
  vpcId: sandbox.vpcId,
  imageRef: sandbox.imageRef,
  ...(sandbox.imageDigest !== undefined && {
    imageDigest: sandbox.imageDigest,
  }),
  resources: { ...sandbox.resources },
  createdAt: sandbox.createdAt,
  ...(sandbox.startedAt !== undefined && { startedAt: sandbox.startedAt }),
  ...(sandbox.endedAt !== undefined && { endedAt: sandbox.endedAt }),
  ...(sandbox.error !== undefined && { error: sandbox.error }),
});

const processRefForWire = (process: SandboxProcess) => ({
  kind: process.kind,
  version: process.version,
  sandboxId: process.sandboxId,
  id: process.id,
  command: [...process.command],
  ...(process.pid !== undefined && { pid: process.pid }),
  state: process.state,
  ...(process.exitCode !== undefined && { exitCode: process.exitCode }),
  ...(process.terminationSignal !== undefined && {
    terminationSignal: process.terminationSignal,
  }),
  ...(process.startedAt !== undefined && { startedAt: process.startedAt }),
  ...(process.endedAt !== undefined && { endedAt: process.endedAt }),
});

const snapshotRefForWire = (snapshot: SandboxSnapshotRef) => ({
  ...snapshot,
  resources: { ...snapshot.resources },
});

/**
 * The wire result of an `exec` operation, with its output fitted to the
 * durable step's size budget.
 */
export const execOperationResult = (result: {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
  /**
   * The full sizes of the output, when the bytes given are only a tail of it.
   */
  originalBytes?: { stdout: number; stderr: number };
}): SandboxOperationResultV1 => {
  const fitted = fitDurableSandboxExecOutput(result.stdout, result.stderr);
  const { originalBytes } = result;
  const output: typeof fitted.output =
    originalBytes &&
    (originalBytes.stdout > fitted.stdout.byteLength ||
      originalBytes.stderr > fitted.stderr.byteLength)
      ? {
          truncated: true,
          strategy: "tail",
          originalBytes,
          retainedBytes: {
            stdout: fitted.stdout.byteLength,
            stderr: fitted.stderr.byteLength,
          },
        }
      : fitted.output;
  const {
    encoding,
    values: [stdout, stderr],
  } = encodeOutput([fitted.stdout, fitted.stderr], {
    truncated: output.truncated
      ? [
          output.retainedBytes.stdout < output.originalBytes.stdout,
          output.retainedBytes.stderr < output.originalBytes.stderr,
        ]
      : [],
  });

  return {
    protocolVersion: sandboxProtocolVersion,
    action: "exec",
    result: {
      stdout: stdout!,
      stderr: stderr!,
      encoding,
      exitCode: result.exitCode,
      output,
    },
  };
};

/**
 * Execute a durable sandbox operation through the public REST client and
 * reduce its result to JSON-safe data suitable for normal step memoization.
 */
export const executeSandboxOperation = async (
  client: SandboxClient,
  rawOperation: unknown,
): Promise<SandboxOperationResultV1> => {
  const operation = parseSandboxOperation(rawOperation);

  switch (operation.action) {
    case "create": {
      const { runningTimeoutMs, ...options } = operation.input[0];
      const sandbox = await createSandboxForOperation(client, {
        ...options,
        ...(runningTimeoutMs !== undefined && {
          runningTimeout: runningTimeoutMs,
        }),
      });
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        sandbox: sandboxRefForWire(sandbox),
      };
    }
    case "list": {
      const result = await client.list(operation.input[0]);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        sandboxes: result.items.map(sandboxRefForWire),
        page: result.page,
        fetchedAt: result.fetchedAt,
      };
    }
    case "get": {
      const sandbox = await client.get(operation.input[0].sandboxId);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        sandbox: sandbox ? sandboxRefForWire(sandbox) : null,
      };
    }
    case "waitUntilRunning": {
      const sandbox = await sandboxForOperation(
        client,
        operation.target.sandbox,
      ).waitUntilRunning({
        timeout: operation.input[0].timeoutMs,
      });
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        sandbox: sandboxRefForWire(sandbox),
      };
    }
    case "exec": {
      const { command, timeoutMs, ...options } = operation.input[0];
      const sandbox = sandboxForOperation(client, operation.target.sandbox);
      const result = await runSandboxCommandForOperation(sandbox, command, {
        ...options,
        timeout: timeoutMs,
      });
      return execOperationResult(result);
    }
    case "file.upload": {
      const { path, data } = operation.input[0];
      await sandboxForOperation(client, operation.target.sandbox).files.upload({
        path,
        data: new Uint8Array(decodeBase64(data, "sandbox file data")),
      });
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result: null,
      };
    }
    case "file.download": {
      const response = await sandboxForOperation(
        client,
        operation.target.sandbox,
      ).files.download(operation.input[0]);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxDurableSandboxExecOutputBytes) {
        throw new SandboxValidationError(
          `${operation.input[0].path} is ${bytes.byteLength} bytes, over the ${maxDurableSandboxExecOutputBytes} bytes a step can return`,
        );
      }
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result: { data: encodeBase64(bytes) },
      };
    }
    case "destroy": {
      // A destroy that already happened, such as one retried after a lost
      // response, has the outcome the caller wanted.
      const result = await sandboxForOperation(client, operation.target.sandbox)
        .destroy()
        .catch((error: unknown): SandboxDestroyResult => {
          if (
            error instanceof SandboxError &&
            error.code === "sandbox_not_found"
          ) {
            return { status: "TERMINATED", sandbox: null };
          }

          throw error;
        });

      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result,
      };
    }
    case "pause":
    case "resume": {
      const sandbox = await sandboxForOperation(
        client,
        operation.target.sandbox,
      )[operation.action]({ timeout: operation.input[0].timeoutMs });
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        sandbox: sandboxRefForWire(sandbox),
      };
    }
    case "process.start": {
      const sandbox = sandboxForOperation(client, operation.target.sandbox);
      const process = await sandbox.processes.start(operation.input[0]);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        process: processRefForWire(process),
      };
    }
    case "process.list": {
      const result = await sandboxForOperation(
        client,
        operation.target.sandbox,
      ).processes.list(operation.input[0]);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        processes: result.items.map(processRefForWire),
        page: { ...result.page },
        fetchedAt: result.fetchedAt,
      };
    }
    case "process.get": {
      const sandbox = sandboxForOperation(client, operation.target.sandbox);
      const process = await sandbox.processes.get(operation.target.processId);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        process: process ? processRefForWire(process) : null,
      };
    }
    case "process.signal": {
      await sandboxProcessForOperation(client, operation.target.process).signal(
        operation.input[0],
      );
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result: null,
      };
    }
    case "process.wait": {
      const { timeoutMs, allowRunning } = operation.input[0];
      const { process: ref } = operation.target;
      const process = await sandboxProcessForOperation(client, ref)
        .wait({ timeout: timeoutMs })
        .catch((error: unknown) => {
          // The server reports an elapsed wait window as an error. For a
          // caller that polls, that is an answer: the process is still RUNNING
          if (
            allowRunning &&
            error instanceof SandboxError &&
            error.code === "sandbox_process_wait_timed_out"
          ) {
            return { ...ref, state: "RUNNING" as const };
          }

          throw error;
        });
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        process: {
          kind: process.kind,
          version: process.version,
          sandboxId: process.sandboxId,
          id: process.id,
          state: process.state as
            | "RUNNING"
            | "EXITED"
            | "KILLED"
            | "FAILED"
            | "LOST",
          ...(process.exitCode !== undefined && {
            exitCode: process.exitCode,
          }),
          ...(process.terminationSignal !== undefined && {
            terminationSignal: process.terminationSignal,
          }),
        },
      };
    }
    case "process.output": {
      const result = await sandboxProcessForOperation(
        client,
        operation.target.process,
      ).getOutput(operation.input[0]);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result: { chunks: result.chunks.map(encodeOutputChunk) },
      };
    }
    case "snapshot.create": {
      const snapshot = await createSandboxSnapshotForOperation(
        client,
        operation.target.sandbox.id,
        operation.input[0],
      );
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        snapshot: snapshotRefForWire(snapshot),
      };
    }
    case "snapshot.list": {
      const result = await listSandboxSnapshotsForOperation(
        client,
        operation.input[0],
      );
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        snapshots: result.items.map(snapshotRefForWire),
        page: { ...result.page },
        fetchedAt: result.fetchedAt,
      };
    }
    case "snapshot.get": {
      const snapshot = await getSandboxSnapshotForOperation(
        client,
        operation.target.snapshotId,
      );
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        snapshot: snapshot ? snapshotRefForWire(snapshot) : null,
      };
    }
    case "snapshot.waitUntilReady": {
      const snapshot = await waitUntilSandboxSnapshotReadyForOperation(
        client,
        operation.target.snapshot,
        operation.input[0].timeoutMs,
      );
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        snapshot: snapshotRefForWire(snapshot),
      };
    }
    case "snapshot.delete": {
      await deleteSandboxSnapshotForOperation(
        client,
        operation.target.snapshot.id,
      );
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result: null,
      };
    }
  }
};

type FileParser = (
  idOrOptions: StepOptionsOrId,
  path: string,
  parse: (bytes: Uint8Array) => unknown,
) => Promise<unknown>;
const fileParsers = new WeakMap<DurableSandbox, FileParser>();
const fileParserOf = (sandbox: DurableSandbox): FileParser => {
  const parser = fileParsers.get(sandbox);
  if (!parser) {
    throw new Error("Cannot parse a file of a sandbox the SDK did not create");
  }

  return parser;
};
const sandboxTarget = (ref: SandboxRef) => ({ sandbox: ref });
const downloadOperation = (ref: SandboxRef, path: string) => {
  return parseSandboxOperationForAction("file.download", {
    protocolVersion: sandboxProtocolVersion,
    action: "file.download",
    target: sandboxTarget(ref),
    input: [{ path }],
  });
};
const processTarget = (sandbox: SandboxRef, process: SandboxProcessRef) => ({
  sandbox,
  process,
});
const snapshotTarget = (snapshot: SandboxSnapshotRef) => ({ snapshot });

export const createDurableSandboxSnapshotFacade = (
  rawRef: unknown,
  rawToolResolver: SandboxRawToolResolver,
): DurableSandboxSnapshot => {
  const ref = parseWithSchema(
    sandboxSnapshotRefSchema,
    rawRef,
    "sandbox snapshot reference",
  );
  const facade: DurableSandboxSnapshot = {
    ...ref,
    resources: Object.freeze({ ...ref.resources }),
    waitUntilReady: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction(
        "snapshot.waitUntilReady",
        {
          protocolVersion: sandboxProtocolVersion,
          action: "snapshot.waitUntilReady",
          target: snapshotTarget(ref),
          input: [normalizeSandboxSnapshotWaitOptions(options)],
        },
      );
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return createDurableSandboxSnapshotFacade(
        result.snapshot,
        rawToolResolver,
      );
    },
    delete: async (idOrOptions) => {
      const operation = parseSandboxOperationForAction("snapshot.delete", {
        protocolVersion: sandboxProtocolVersion,
        action: "snapshot.delete",
        target: snapshotTarget(ref),
        input: [],
      });
      await callRawTool(rawToolResolver, idOrOptions, operation);
    },
    clone: async (idOrOptions, options, waitOptions) => {
      const operation = parseSandboxOperationForAction("create", {
        protocolVersion: sandboxProtocolVersion,
        action: "create",
        input: [
          normalizeSandboxCreateOptions({
            name: options.name,
            snapshotId: ref.id,
            runningTimeout: options.runningTimeout ?? waitOptions?.timeout,
          }),
        ],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return createDurableSandboxFacade(result.sandbox, rawToolResolver);
    },
  };
  return Object.freeze(facade);
};

export const createDurableSandboxProcessFacade = (
  rawRef: unknown,
  sandboxRef: SandboxRef,
  rawToolResolver: SandboxRawToolResolver,
): DurableSandboxProcess => {
  const ref = parseWithSchema(
    sandboxProcessRefSchema,
    rawRef,
    "sandbox process reference",
  );
  if (ref.sandboxId !== sandboxRef.id) {
    throw new SandboxValidationError(
      "Sandbox process reference belongs to another sandbox",
    );
  }
  const facade: DurableSandboxProcess = {
    ...ref,
    command: Object.freeze([...ref.command]),
    signal: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction("process.signal", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.signal",
        target: processTarget(sandboxRef, ref),
        input: [normalizeSandboxProcessSignalOptions(options)],
      });
      await callRawTool(rawToolResolver, idOrOptions, operation);
    },
    wait: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction("process.wait", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.wait",
        target: processTarget(sandboxRef, ref),
        input: [normalizeSandboxProcessWaitOptions(options)],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      const {
        exitCode: _previousExitCode,
        terminationSignal: _previousTerminationSignal,
        ...baseRef
      } = ref;
      return createDurableSandboxProcessFacade(
        parseWithSchema(
          sandboxProcessRefSchema,
          {
            ...baseRef,
            state: result.process.state,
            ...(result.process.exitCode !== undefined && {
              exitCode: result.process.exitCode,
            }),
            ...(result.process.terminationSignal !== undefined && {
              terminationSignal: result.process.terminationSignal,
            }),
          },
          "sandbox process reference",
        ),
        sandboxRef,
        rawToolResolver,
      );
    },
    getOutput: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction("process.output", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.output",
        target: processTarget(sandboxRef, ref),
        input: [normalizeSandboxProcessOutputOptions(options)],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return {
        chunks: result.result.chunks.map(decodeOutputChunk),
      };
    },
  };
  return Object.freeze(facade);
};

export const createDurableSandboxFacade = (
  rawRef: unknown,
  rawToolResolver: SandboxRawToolResolver,
): DurableSandbox => {
  const ref = parseWithSchema(sandboxRefSchema, rawRef, "sandbox reference");
  const createSnapshot: DurableSandbox["snapshot"] = async (
    idOrOptions,
    options,
    waitOptions,
  ) => {
    const createOptions = normalizeSandboxSnapshotCreateOptions(options);
    const wait = normalizeSandboxSnapshotWaitOptions({
      timeout: waitOptions?.timeout ?? 5 * 60_000,
    });
    const createOperation = parseSandboxOperationForAction("snapshot.create", {
      protocolVersion: sandboxProtocolVersion,
      action: "snapshot.create",
      target: sandboxTarget(ref),
      input: [createOptions],
    });
    // The caller's name labels the span around both steps, so each step is
    // named for what it does and marked as the SDK's own work. Step IDs never
    // change, for replay.
    const stepOptions = getStepOptions(idOrOptions);
    const created = await callRawTool(
      rawToolResolver,
      { ...stepOptions, name: "Create snapshot", "~origin": sdkOrigin },
      createOperation,
    );
    const waitOperation = parseSandboxOperationForAction(
      "snapshot.waitUntilReady",
      {
        protocolVersion: sandboxProtocolVersion,
        action: "snapshot.waitUntilReady",
        target: snapshotTarget(created.snapshot),
        input: [wait],
      },
    );
    const ready = await callRawTool(
      rawToolResolver,
      {
        ...stepOptions,
        id: `${stepOptions.id}:wait-until-ready`,
        name: "Wait for snapshot",
        "~origin": sdkOrigin,
      },
      waitOperation,
    );
    return createDurableSandboxSnapshotFacade(ready.snapshot, rawToolResolver);
  };
  // The create and readiness wait are one statement, so they share one span
  // of kind `snapshot`. A caller that already groups the statement (such as
  // `@inngest/ci`) passes its own `"~span"`, which both steps carry, so the
  // statement is never grouped twice.
  const snapshot: DurableSandbox["snapshot"] = (idOrOptions, ...args) => {
    const { id, name, "~span": callerSpan } = getStepOptions(idOrOptions);

    if (callerSpan) {
      return createSnapshot(idOrOptions, ...args);
    }

    return withSpan({ id, name, kind: "snapshot" }, () => {
      return createSnapshot(idOrOptions, ...args);
    });
  };
  const run: DurableSandbox["commands"]["run"] = async (
    idOrOptions,
    command,
    options,
  ) => {
    const {
      tools: ownTools,
      toolOptions,
      exitCodes,
      shims,
      "~shell": shell,
      ...commandOptions
    } = options ?? {};

    parseWithSchema(exitCodesSchema.optional(), exitCodes, "exitCodes");

    const checked = shims === undefined ? [] : validateShims(shims);
    const binary = checked.some((one) => {
      return one.kind === "program";
    })
      ? await bundledToolBinary()
      : undefined;
    const shimmed =
      checked.length > 0 ? withShims(command, checked, { binary }) : undefined;
    for (const name of Object.keys(shimmed?.tools ?? {})) {
      if (ownTools && Object.hasOwn(ownTools, name)) {
        throw new SandboxValidationError(
          `The tool name "${name}" is used by shims`,
        );
      }
    }

    const tools =
      ownTools || shimmed ? { ...ownTools, ...shimmed?.tools } : undefined;
    const text = shell?.text ?? commandText(command);
    const timeoutMs =
      commandOptions.timeout === undefined
        ? undefined
        : normalizeDurationMs(
            commandOptions.timeout,
            Number.POSITIVE_INFINITY,
            "timeout",
          );

    // A command that may outlive one step's wait runs as a process
    if (
      !tools &&
      timeoutMs !== undefined &&
      timeoutMs > maxSandboxProcessTimeoutMs
    ) {
      const { timeout: _timeout, ...spec } = commandOptions;

      return runManagedCommand({
        rawToolResolver,
        sandbox: ref,
        idOrOptions,
        spec: { ...spec, command },
        text,
        timeoutMs,
        exitCodes: exitCodes ?? "any",
        strip: shell?.strip,
      });
    }

    // A command with tools is always a process that steps follow in windows,
    // so its timeout is its own, however long. The operation below only
    // carries the command, so its timeout stays within what one exec accepts.
    const toolsTimeoutMs = timeoutMs ?? maxSandboxProcessTimeoutMs;
    const normalized = normalizeSandboxCommandOptions(command, {
      ...commandOptions,
      ...(tools && {
        timeout: Math.min(toolsTimeoutMs, maxSandboxProcessTimeoutMs),
      }),
    });
    const { timeout: _timeout, ...input } = normalized;
    const operation = parseSandboxOperationForAction("exec", {
      protocolVersion: sandboxProtocolVersion,
      action: "exec",
      target: sandboxTarget(ref),
      input: [input],
    });
    const toResult = (
      wire: SandboxResultForAction<"exec">,
    ): SandboxCommandResult => {
      return {
        stdout: decodeUtf8(
          decodeOutputData(
            wire.result.stdout,
            wire.result.encoding,
            "sandbox exec stdout",
          ),
        ),
        stderr: decodeUtf8(
          decodeOutputData(
            wire.result.stderr,
            wire.result.encoding,
            "sandbox exec stderr",
          ),
        ),
        exitCode: wire.result.exitCode,
        output: wire.result.output,
      };
    };

    // The exit is checked inside the step, so a disallowed one fails the step
    // and a replay throws it again. A command with tools has no single step
    // for it, so it is checked on the result, which replays the same.
    const result = await callRawTool(
      rawToolResolver,
      idOrOptions,
      operation,
      !tools && exitCodes && exitCodes !== "any"
        ? (wire) => {
            const seen = toResult(wire);

            checkExit(exitCodes, {
              command: text,
              ...seen,
              stdout: shell ? shell.strip(seen.stdout) : seen.stdout,
            });

            return wire;
          }
        : undefined,
      tools && {
        tools,
        toolOptions,
        binary,
        timeoutMs: toolsTimeoutMs,
        command: shimmed?.command,
      },
    );

    if (tools && exitCodes && exitCodes !== "any") {
      checkExit(exitCodes, { command: text, ...toResult(result) });
    }

    return toResult(result);
  };
  const facade: DurableSandbox = {
    $: createDollar(run),
    shell: (shellOptions) => {
      return createShell(run, shellOptions);
    },
    ...ref,
    resources: Object.freeze({ ...ref.resources }),
    tools: { code: (options) => codeTools(facade, options) },
    commands: Object.freeze({ run }),
    files: Object.freeze({
      write: async (idOrOptions, { path, data }) => {
        const operation = parseSandboxOperationForAction("file.upload", {
          protocolVersion: sandboxProtocolVersion,
          action: "file.upload",
          target: sandboxTarget(ref),
          input: [
            {
              path,
              data: encodeBase64(
                typeof data === "string"
                  ? new TextEncoder().encode(data)
                  : data,
              ),
            },
          ],
        });
        await callRawTool(rawToolResolver, idOrOptions, operation);
      },
      read: async (idOrOptions, path) => {
        const result = await callRawTool(
          rawToolResolver,
          idOrOptions,
          downloadOperation(ref, path),
        );
        return decodeBase64(result.result.data, "sandbox file data");
      },
    }),
    processes: Object.freeze({
      start: async (idOrOptions, options) => {
        const operation = parseSandboxOperationForAction("process.start", {
          protocolVersion: sandboxProtocolVersion,
          action: "process.start",
          target: sandboxTarget(ref),
          input: [normalizeSandboxProcessStartOptions(options)],
        });
        const result = await callRawTool(
          rawToolResolver,
          idOrOptions,
          operation,
        );
        return createDurableSandboxProcessFacade(
          result.process,
          ref,
          rawToolResolver,
        );
      },
      list: async (idOrOptions, options) => {
        const operation = parseSandboxOperationForAction("process.list", {
          protocolVersion: sandboxProtocolVersion,
          action: "process.list",
          target: sandboxTarget(ref),
          input: [normalizeSandboxProcessListOptions(options)],
        });
        const result = await callRawTool(
          rawToolResolver,
          idOrOptions,
          operation,
        );
        return {
          items: result.processes.map((process) =>
            createDurableSandboxProcessFacade(process, ref, rawToolResolver),
          ),
          page: { ...result.page },
          fetchedAt: result.fetchedAt,
        };
      },
      get: async (idOrOptions, processId) => {
        const parsedProcessId = parseWithSchema(
          canonicalUuidSchema,
          processId,
          "sandbox process ID",
        );
        const operation = parseSandboxOperationForAction("process.get", {
          protocolVersion: sandboxProtocolVersion,
          action: "process.get",
          target: { sandbox: ref, processId: parsedProcessId },
          input: [],
        });
        const result = await callRawTool(
          rawToolResolver,
          idOrOptions,
          operation,
        );
        return result.process
          ? createDurableSandboxProcessFacade(
              result.process,
              ref,
              rawToolResolver,
            )
          : null;
      },
    }),
    snapshots: Object.freeze({
      create: snapshot,
    }),
    snapshot,
    waitUntilRunning: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction("waitUntilRunning", {
        protocolVersion: sandboxProtocolVersion,
        action: "waitUntilRunning",
        target: sandboxTarget(ref),
        input: [normalizeSandboxWaitUntilRunningOptions(options)],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return createDurableSandboxFacade(result.sandbox, rawToolResolver);
    },
    pause: async (idOrOptions, options) => {
      const input = normalizeSandboxWaitUntilRunningOptions({
        timeout: options?.timeout ?? 5 * 60_000,
      });
      const operation = parseSandboxOperationForAction("pause", {
        protocolVersion: sandboxProtocolVersion,
        action: "pause",
        target: sandboxTarget(ref),
        input: [input],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return createDurableSandboxFacade(result.sandbox, rawToolResolver);
    },
    resume: async (idOrOptions, options) => {
      const input = normalizeSandboxWaitUntilRunningOptions({
        timeout: options?.timeout ?? 5 * 60_000,
      });
      const operation = parseSandboxOperationForAction("resume", {
        protocolVersion: sandboxProtocolVersion,
        action: "resume",
        target: sandboxTarget(ref),
        input: [input],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return createDurableSandboxFacade(result.sandbox, rawToolResolver);
    },
    destroy: async (idOrOptions): Promise<SandboxDestroyResult> => {
      const operation = parseSandboxOperationForAction("destroy", {
        protocolVersion: sandboxProtocolVersion,
        action: "destroy",
        target: sandboxTarget(ref),
        input: [],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return result.result;
    },
  };
  fileParsers.set(facade, (idOrOptions, path, parse) => {
    return callRawTool(
      rawToolResolver,
      idOrOptions,
      downloadOperation(ref, path),
      (result) => {
        return parse(decodeBase64(result.result.data, "sandbox file data"));
      },
    );
  });

  return Object.freeze(facade);
};

/**
 * Read a file in the sandbox and parse it inside the same step, so the step's
 * output is what `parse` returns instead of the file. Internal: the public
 * `files.read` always returns the bytes.
 */
export const readParsedFile = <T>(
  sandbox: DurableSandbox,
  idOrOptions: StepOptionsOrId,
  path: string,
  parse: (bytes: Uint8Array) => T | Promise<T>,
): Promise<T> => {
  return fileParserOf(sandbox)(idOrOptions, path, parse) as Promise<T>;
};

export const createSandboxTools = (
  rawToolResolver: SandboxRawToolResolver,
  registerCleanup?: SandboxCleanupRegistrar,
): DurableSandboxTools => {
  const tools: DurableSandboxTools = {
    create: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction("create", {
        protocolVersion: sandboxProtocolVersion,
        action: "create",
        input: [normalizeSandboxCreateOptions(options)],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      const sandbox = createDurableSandboxFacade(
        result.sandbox,
        rawToolResolver,
      );
      const { id } = getStepOptions(idOrOptions);

      // `await using` reads the dispose method as it declares the sandbox, so
      // that read is what marks the sandbox as scoped. A plain create never
      // reads it and is left running when the run ends.
      let cleanup: DeferHandle | undefined;
      const disposable = Object.defineProperty({ ...sandbox }, asyncDispose, {
        get: () => {
          cleanup ??= registerCleanup?.(id, {
            sandboxId: result.sandbox.id,
          });

          return async () => {
            await destroyQuietly(sandbox, `${id}:destroy`, cleanup);
          };
        },
      }) as DurableSandbox & AsyncDisposable;
      Object.freeze(disposable);
      fileParsers.set(disposable, fileParserOf(sandbox));

      return disposable;
    },
    list: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction("list", {
        protocolVersion: sandboxProtocolVersion,
        action: "list",
        input: [normalizeSandboxListOptions(options)],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return {
        items: result.sandboxes.map((sandbox) =>
          createDurableSandboxFacade(sandbox, rawToolResolver),
        ),
        page: { ...result.page },
        fetchedAt: result.fetchedAt,
      };
    },
    get: async (idOrOptions, sandboxId) => {
      const parsedSandboxId = parseWithSchema(
        canonicalUuidSchema,
        sandboxId,
        "sandbox ID",
      );
      const operation = parseSandboxOperationForAction("get", {
        protocolVersion: sandboxProtocolVersion,
        action: "get",
        input: [{ sandboxId: parsedSandboxId }],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return result.sandbox
        ? createDurableSandboxFacade(result.sandbox, rawToolResolver)
        : null;
    },
    snapshots: {
      list: async (idOrOptions, options) => {
        const operation = parseSandboxOperationForAction("snapshot.list", {
          protocolVersion: sandboxProtocolVersion,
          action: "snapshot.list",
          input: [normalizeSandboxSnapshotListOptions(options)],
        });
        const result = await callRawTool(
          rawToolResolver,
          idOrOptions,
          operation,
        );
        return {
          items: result.snapshots.map((snapshot) =>
            createDurableSandboxSnapshotFacade(snapshot, rawToolResolver),
          ),
          page: { ...result.page },
          fetchedAt: result.fetchedAt,
        };
      },
      get: async (idOrOptions, snapshotId) => {
        const parsedSnapshotId = parseWithSchema(
          canonicalUuidSchema,
          snapshotId,
          "sandbox snapshot ID",
        );
        const operation = parseSandboxOperationForAction("snapshot.get", {
          protocolVersion: sandboxProtocolVersion,
          action: "snapshot.get",
          target: { snapshotId: parsedSnapshotId },
          input: [],
        });
        const result = await callRawTool(
          rawToolResolver,
          idOrOptions,
          operation,
        );
        return result.snapshot
          ? createDurableSandboxSnapshotFacade(result.snapshot, rawToolResolver)
          : null;
      },
    },
  };

  if (registerCleanup) {
    setCleanupRegistrar(tools, registerCleanup);
  }

  return tools;
};
