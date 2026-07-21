import type { StepOptionsOrId } from "../../types.ts";
import {
  findSandboxErrorOptions,
  parseSandboxOperationForAction,
  type SandboxOperationForAction,
  type SandboxRawToolResolver,
  type SandboxResultForAction,
  validateSandboxResult,
} from "./protocol.ts";
import {
  type DurableSandbox,
  type DurableSandboxProcess,
  type DurableSandboxTools,
  type SandboxAction,
  type SandboxDestroyResult,
  SandboxError,
  type SandboxProcessRef,
  type SandboxRef,
  SandboxValidationError,
  sandboxProtocolVersion,
} from "./types.ts";
import {
  canonicalUuidSchema,
  decodeBase64,
  decodeOutputChunk,
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
    throw error;
  }
};

const sandboxTarget = (ref: SandboxRef) => ({ sandboxId: ref.id });
const processTarget = (ref: SandboxProcessRef) => ({
  sandboxId: ref.sandboxId,
  processId: ref.id,
});

export const createDurableSandboxProcessFacade = (
  rawRef: unknown,
  rawToolResolver: SandboxRawToolResolver,
): DurableSandboxProcess => {
  const ref = parseWithSchema(
    sandboxProcessRefSchema,
    rawRef,
    "sandbox process reference",
  );
  const facade: DurableSandboxProcess = {
    ...ref,
    command: Object.freeze([...ref.command]),
    refresh: async (idOrOptions) => {
      const operation = parseSandboxOperationForAction("process.get", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.get",
        target: processTarget(ref),
        input: [],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return result.process
        ? createDurableSandboxProcessFacade(result.process, rawToolResolver)
        : null;
    },
    signal: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction("process.signal", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.signal",
        target: processTarget(ref),
        input: [normalizeSandboxProcessSignalOptions(options)],
      });
      await callRawTool(rawToolResolver, idOrOptions, operation);
    },
    wait: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction("process.wait", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.wait",
        target: processTarget(ref),
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
        rawToolResolver,
      );
    },
    getOutput: async (idOrOptions, options) => {
      const operation = parseSandboxOperationForAction("process.output", {
        protocolVersion: sandboxProtocolVersion,
        action: "process.output",
        target: processTarget(ref),
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
        return result.processes.map((process) =>
          createDurableSandboxProcessFacade(process, rawToolResolver),
        );
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
          target: { sandboxId: ref.id, processId: parsedProcessId },
          input: [],
        });
        const result = await callRawTool(
          rawToolResolver,
          idOrOptions,
          operation,
        );
        return result.process
          ? createDurableSandboxProcessFacade(result.process, rawToolResolver)
          : null;
      },
    }),
    refresh: async (idOrOptions) => {
      const operation = parseSandboxOperationForAction("get", {
        protocolVersion: sandboxProtocolVersion,
        action: "get",
        input: [{ sandboxId: ref.id }],
      });
      const result = await callRawTool(rawToolResolver, idOrOptions, operation);
      return result.sandbox
        ? createDurableSandboxFacade(result.sandbox, rawToolResolver)
        : null;
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
