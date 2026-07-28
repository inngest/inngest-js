import type { StepOptionsOrId } from "../../types.ts";
import { attachSandboxProcess } from "./client.ts";
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
import {
  type DurableSandbox,
  type DurableSandboxProcess,
  type DurableSandboxTools,
  type SandboxAction,
  type SandboxClient,
  type SandboxCommandResult,
  type SandboxDestroyResult,
  SandboxError,
  type SandboxOutputChunk,
  type SandboxProcessRef,
  type SandboxRef,
  SandboxValidationError,
  sandboxProtocolVersion,
} from "./types.ts";
import {
  canonicalUuidSchema,
  decodeBase64,
  decodeOutputChunk,
  encodeBase64,
  normalizeSandboxCommandOptions,
  normalizeSandboxCreateOptions,
  normalizeSandboxListOptions,
  normalizeSandboxProcessOutputOptions,
  normalizeSandboxProcessSignalOptions,
  normalizeSandboxProcessStartOptions,
  normalizeSandboxProcessWaitOptions,
  parseWithSchema,
  sandboxProcessRefSchema,
  sandboxRefSchema,
} from "./validation.ts";

const fitDurableSandboxExecOutput = (
  stdout: Uint8Array,
  stderr: Uint8Array,
): Pick<SandboxCommandResult, "stdout" | "stderr" | "output"> => {
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

const processRefForWire = (ref: SandboxProcessRef) => ({
  ...ref,
  command: [...ref.command],
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
      const sandbox = await client.create(operation.input[0]);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        sandbox: sandbox.toJSON(),
      };
    }
    case "list": {
      const result = await client.list(operation.input[0]);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        sandboxes: result.items.map((sandbox) => sandbox.toJSON()),
        page: result.page,
        fetchedAt: result.fetchedAt,
      };
    }
    case "get": {
      const sandbox = await client.get(operation.input[0].sandboxId);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        sandbox: sandbox?.toJSON() ?? null,
      };
    }
    case "exec": {
      const { timeoutMs, ...options } = operation.input[0];
      const result = await client
        .attach(operation.target.sandbox)
        .commands.run({ ...options, timeout: timeoutMs });
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
    case "destroy": {
      const result = await client.attach(operation.target.sandbox).destroy();
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result,
      };
    }
    case "process.start": {
      const process = await client
        .attach(operation.target.sandbox)
        .processes.start(operation.input[0]);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        process: processRefForWire(process.toJSON()),
      };
    }
    case "process.list": {
      const result = await client
        .attach(operation.target.sandbox)
        .processes.list();
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        processes: result.items.map((process) =>
          processRefForWire(process.toJSON()),
        ),
        fetchedAt: result.fetchedAt,
      };
    }
    case "process.get": {
      const process = await client
        .attach(operation.target.sandbox)
        .processes.get(operation.target.processId);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        process: process ? processRefForWire(process.toJSON()) : null,
      };
    }
    case "process.signal": {
      await attachSandboxProcess(client, operation.target.process).signal(
        operation.input[0],
      );
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result: null,
      };
    }
    case "process.wait": {
      const process = await attachSandboxProcess(
        client,
        operation.target.process,
      ).wait({ timeout: operation.input[0].timeoutMs });
      const ref = process.toJSON();
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        process: {
          kind: ref.kind,
          version: ref.version,
          sandboxId: ref.sandboxId,
          id: ref.id,
          state: ref.state as "EXITED" | "KILLED" | "FAILED" | "LOST",
          ...(ref.exitCode !== undefined && { exitCode: ref.exitCode }),
          ...(ref.terminationSignal !== undefined && {
            terminationSignal: ref.terminationSignal,
          }),
        },
      };
    }
    case "process.output": {
      const result = await attachSandboxProcess(
        client,
        operation.target.process,
      ).getOutput(operation.input[0]);
      return {
        protocolVersion: sandboxProtocolVersion,
        action: operation.action,
        result: { chunks: result.chunks.map(encodeOutputChunk) },
      };
    }
  }
};

const callRawTool = async <A extends SandboxAction>(
  rawToolResolver: SandboxRawToolResolver,
  idOrOptions: StepOptionsOrId,
  operation: SandboxOperationForAction<A>,
): Promise<SandboxResultForAction<A>> => {
  try {
    const rawTool = await rawToolResolver();
    return validateSandboxResult(
      operation,
      await rawTool(idOrOptions, operation),
    );
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
      throw new SandboxError(options);
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

const sandboxTarget = (ref: SandboxRef) => ({ sandbox: ref });
const processTarget = (sandbox: SandboxRef, process: SandboxProcessRef) => ({
  sandbox,
  process,
});

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
    toJSON: () => ({
      ...ref,
      command: [...ref.command],
    }),
  };
  return Object.freeze(facade);
};

export const createDurableSandboxFacade = (
  rawRef: unknown,
  rawToolResolver: SandboxRawToolResolver,
): DurableSandbox => {
  const ref = parseWithSchema(sandboxRefSchema, rawRef, "sandbox reference");
  const facade: DurableSandbox = {
    ...ref,
    resources: Object.freeze({ ...ref.resources }),
    commands: Object.freeze({
      run: async (idOrOptions, options) => {
        const normalized = normalizeSandboxCommandOptions(options);
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
          stdout: decodeBase64(result.result.stdout, "sandbox exec stdout"),
          stderr: decodeBase64(result.result.stderr, "sandbox exec stderr"),
          exitCode: result.result.exitCode,
          output: result.result.output,
        };
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
      list: async (idOrOptions) => {
        const operation = parseSandboxOperationForAction("process.list", {
          protocolVersion: sandboxProtocolVersion,
          action: "process.list",
          target: sandboxTarget(ref),
          input: [],
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
    toJSON: () => ({
      ...ref,
      resources: { ...ref.resources },
    }),
  };
  return Object.freeze(facade);
};

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
    return createDurableSandboxFacade(result.sandbox, rawToolResolver);
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
  attach: (ref) => createDurableSandboxFacade(ref, rawToolResolver),
});
