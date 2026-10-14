import type { StepOptionsOrId } from "../../types.ts";
import { getStepOptions, withSpan } from "../InngestStepTools.ts";
import { StepError } from "../StepError.ts";
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
import { destroyQuietly } from "./group.ts";
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
import { createSandboxRunner } from "./runners.ts";
import { sdkOrigin } from "./trace.ts";
import {
  type DurableSandbox,
  type DurableSandboxProcess,
  type DurableSandboxSnapshot,
  type DurableSandboxTools,
  type Sandbox,
  type SandboxAction,
  type SandboxClient,
  type SandboxCommandOutputMetadata,
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
  decodeUtf8,
  encodeBase64,
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
  output: SandboxCommandOutputMetadata;
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
  encoding: "base64";
  at?: string;
} => ({
  stream: chunk.stream,
  data: encodeBase64(chunk.data),
  encoding: "base64",
  ...(chunk.at !== undefined && { at: chunk.at }),
});

const sandboxRefForWire = (sandbox: Sandbox): SandboxRef => ({
  kind: sandbox.kind,
  version: sandbox.version,
  id: sandbox.id,
  name: sandbox.name,
  status: sandbox.status,
  vpcId: sandbox.vpcId,
  imageRef: sandbox.imageRef,
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
      const output = fitDurableSandboxExecOutput(result.stdout, result.stderr);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result: {
          stdout: encodeBase64(output.stdout),
          stderr: encodeBase64(output.stderr),
          encoding: "base64",
          exitCode: result.exitCode,
          output: output.output,
        },
      };
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
      const process = await sandboxProcessForOperation(
        client,
        operation.target.process,
      ).wait({ timeout: operation.input[0].timeoutMs });
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        process: {
          kind: process.kind,
          version: process.version,
          sandboxId: process.sandboxId,
          id: process.id,
          state: process.state as "EXITED" | "KILLED" | "FAILED" | "LOST",
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

/**
 * Run an operation as a step. With `finish`, the step also does that work and
 * its output is what `finish` returns, so a replay returns it unchanged.
 */
const callRawTool = async <
  A extends SandboxAction,
  T = SandboxResultForAction<A>,
>(
  rawToolResolver: SandboxRawToolResolver,
  idOrOptions: StepOptionsOrId,
  operation: SandboxOperationForAction<A>,
  finish?: (result: SandboxResultForAction<A>) => T | Promise<T>,
): Promise<T> => {
  try {
    const rawTool = await rawToolResolver();
    if (finish) {
      return (await rawTool(idOrOptions, operation, (result) => {
        return finish(validateSandboxResult(operation, result));
      })) as T;
    }

    return validateSandboxResult(
      operation,
      await rawTool(idOrOptions, operation),
    ) as T;
  } catch (error) {
    if (error instanceof SandboxValidationError) {
      throw error;
    }
    const options = findSandboxErrorOptions(error);
    if (options) {
      if (options.action !== operation.action) {
        throw new SandboxValidationError(
          `Sandbox operation returned a ${options.action} error for ${operation.action}`,
        );
      }
      // A failed step rejects with the engine's own StepError. Rethrow that
      // exact error so it behaves like any other step: left uncaught, it fails
      // the function without retrying it.
      if (error instanceof StepError) {
        throw error;
      }
      throw new SandboxError(options);
    }
    if (error instanceof StepError) {
      throw error;
    }
    const validationError = findSandboxValidationError(error);
    if (validationError) {
      throw new SandboxValidationError(validationError.message, {
        cause: error,
      });
    }
    throw error;
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
  const facade: DurableSandbox = {
    ...ref,
    resources: Object.freeze({ ...ref.resources }),
    commands: Object.freeze({
      run: async (idOrOptions, command, options) => {
        const normalized = normalizeSandboxCommandOptions(command, options);
        const { timeout: _timeout, ...input } = normalized;
        const operation = parseSandboxOperationForAction("exec", {
          protocolVersion: sandboxProtocolVersion,
          action: "exec",
          target: sandboxTarget(ref),
          input: [input],
        });
        const result = await callRawTool(
          rawToolResolver,
          idOrOptions,
          operation,
        );
        return {
          stdout: decodeUtf8(
            decodeBase64(result.result.stdout, "sandbox exec stdout"),
          ),
          stderr: decodeUtf8(
            decodeBase64(result.result.stderr, "sandbox exec stderr"),
          ),
          exitCode: result.result.exitCode,
          output: result.result.output,
        };
      },
    }),
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
    python: createSandboxRunner(() => facade, "python"),
    typescript: createSandboxRunner(() => facade, "typescript"),
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

// Node before 20.5 lacks the symbol that `await using` looks up.
(Symbol as { asyncDispose?: symbol }).asyncDispose ??= Symbol.for(
  "Symbol.asyncDispose",
);

export const createSandboxTools = (
  rawToolResolver: SandboxRawToolResolver,
): DurableSandboxTools => ({
  create: async (idOrOptions, options) => {
    const operation = parseSandboxOperationForAction("create", {
      protocolVersion: sandboxProtocolVersion,
      action: "create",
      input: [normalizeSandboxCreateOptions(options)],
    });
    const result = await callRawTool(rawToolResolver, idOrOptions, operation);
    const sandbox = createDurableSandboxFacade(result.sandbox, rawToolResolver);
    const { id } = getStepOptions(idOrOptions);

    const disposable = Object.freeze({
      ...sandbox,
      [Symbol.asyncDispose]: async () => {
        await destroyQuietly(sandbox, `${id}:destroy`);
      },
    });
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
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
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
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return result.snapshot
        ? createDurableSandboxSnapshotFacade(result.snapshot, rawToolResolver)
        : null;
    },
  },
});
