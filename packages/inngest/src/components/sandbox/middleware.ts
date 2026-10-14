import type { StepOptionsOrId } from "../../types.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import type { Inngest } from "../Inngest.ts";
import type { MetadataKind, MetadataOpcode } from "../InngestMetadata.ts";
import { Middleware } from "../middleware/middleware.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { sandboxForOperation } from "./client.ts";
import { createSandboxTools, executeSandboxOperation } from "./durable.ts";
import { createGroupSandbox, type GroupSandbox } from "./group.ts";
import {
  getSandboxError,
  operationSandboxId,
  parseSandboxOperation,
  type SandboxOperationResultV1,
  type SandboxRawTool,
} from "./protocol.ts";
import { createOneShotRunner, type OneShotRunner } from "./runners.ts";
import { runCommandWithTools } from "./toolRunner.ts";
import {
  type SandboxTraceMetadata,
  sandboxMetadataKind,
  sandboxTraceMetadata,
} from "./trace.ts";
import {
  type DurableSandboxTools,
  SandboxError,
  SandboxValidationError,
  sandboxProtocolVersion,
} from "./types.ts";

type SandboxStepExtension = {
  sandbox: DurableSandboxTools & {
    python: OneShotRunner;
    typescript: OneShotRunner;
    ruby: OneShotRunner;
  };
};

type SandboxGroupExtension = {
  sandbox: GroupSandbox;
};

/**
 * Attach metadata to the step that's executing. Tracing must never fail the
 * step.
 */
const addStepMetadata = (
  kind: MetadataKind,
  values: () => Record<string, unknown> | undefined,
  op: MetadataOpcode = "merge",
): void => {
  try {
    const execution = getAsyncCtxSync()?.execution;
    const stepId = execution?.executingStep?.id;
    if (!execution || !stepId) {
      return;
    }

    const metadata = values();

    if (metadata) {
      execution.instance.addMetadata(stepId, kind, "step", op, metadata);
    }
  } catch {
    // An operation that fails validation has nothing to describe.
  }
};

const describeStep = (
  operation: unknown,
  outcome: { result: SandboxOperationResultV1 } | { error: unknown },
): void => {
  addStepMetadata(sandboxMetadataKind, () => {
    return sandboxTraceMetadata(
      parseSandboxOperation(operation),
      "result" in outcome ? outcome : { error: getSandboxError(outcome.error) },
    );
  });

  if ("error" in outcome) {
    addStepMetadata(
      "inngest.warnings",
      () => {
        const parsed = parseSandboxOperation(operation);

        if (parsed.action !== "destroy") {
          return;
        }

        return {
          "sdk.sandbox.destroy": `Sandbox ${operationSandboxId(parsed)} couldn't be destroyed: ${
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error)
          }`,
        };
      },
      "set",
    );
  }
};

/**
 * What a failed sandbox step throws: retryable errors retry, the rest do not.
 */
const toStepError = (error: unknown): unknown => {
  if (error instanceof SandboxError) {
    const cause = {
      protocolVersion: error.protocolVersion,
      action: error.action,
      code: error.code,
      message: error.message,
      ...(error.status !== undefined && { status: error.status }),
      ...(error.sandboxId !== undefined && { sandboxId: error.sandboxId }),
      ...(error.processId !== undefined && { processId: error.processId }),
      ...(error.snapshotId !== undefined && { snapshotId: error.snapshotId }),
      ambiguous: error.ambiguous,
      retryable: error.retryable,
      ...(error.requestId !== undefined && { requestId: error.requestId }),
      details: [...error.details],
    };
    if (error.retryable) {
      const retryableError = new Error(error.message, { cause });
      retryableError.name = error.name;
      return retryableError;
    }
    return new NonRetriableError(error.message, { cause });
  }
  if (error instanceof SandboxValidationError) {
    return new NonRetriableError(error.message, {
      cause: {
        protocolVersion: sandboxProtocolVersion,
        type: "sandbox_validation_error" as const,
        message: error.message,
      },
    });
  }
  return error;
};

const executeAsStep = async (
  client: Inngest.Any,
  operation: unknown,
): Promise<unknown> => {
  try {
    const result = await executeSandboxOperation(client.sandboxes, operation);
    describeStep(operation, { result });
    return result;
  } catch (error) {
    describeStep(operation, { error });
    throw toStepError(error);
  }
};

/**
 * Adds the durable `step.sandbox` facade using ordinary `step.run` calls.
 *
 * The executor only sees a normal planned step. Its handler calls the same REST
 * client exposed as `inngest.sandboxes`, then returns JSON-safe wire data for
 * replay.
 */
export class SandboxMiddleware extends Middleware.BaseMiddleware {
  readonly id = "inngest:sandbox";

  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs & {
    ctx: Middleware.TransformFunctionInputArgs["ctx"] & {
      step: Middleware.TransformFunctionInputArgs["ctx"]["step"] &
        SandboxStepExtension;
      group: Middleware.TransformFunctionInputArgs["ctx"]["group"] &
        SandboxGroupExtension;
    };
  } {
    const { step, runId } = arg.ctx;
    const rawTool: SandboxRawTool = (idOrOptions, operation, tools, finish) => {
      if (tools && operation.action === "exec") {
        return runCommandWithTools(
          {
            run: async <T>(
              idOrOptions: StepOptionsOrId,
              fn: () => Promise<T>,
              meta?: SandboxTraceMetadata,
            ) => {
              return (await step.run(idOrOptions, async () => {
                try {
                  const result = await fn();
                  if (meta) {
                    addStepMetadata(sandboxMetadataKind, () => {
                      return meta;
                    });
                  }

                  return result;
                } catch (error) {
                  throw toStepError(error);
                }
              })) as T;
            },
            sandbox: sandboxForOperation(
              this.client.sandboxes,
              operation.target.sandbox,
            ),
            runId,
          },
          idOrOptions,
          operation,
          tools,
        );
      }

      return step.run(
        idOrOptions,
        async (input) => {
          const result = await executeAsStep(this.client, input);

          return finish ? finish(result) : result;
        },
        operation,
      );
    };

    const sandbox = createSandboxTools(() => rawTool);

    return {
      ...arg,
      ctx: {
        ...arg.ctx,
        step: {
          ...arg.ctx.step,
          sandbox: {
            ...sandbox,
            python: createOneShotRunner(sandbox, "python"),
            typescript: createOneShotRunner(sandbox, "typescript"),
            ruby: createOneShotRunner(sandbox, "ruby"),
          },
        },
        group: { ...arg.ctx.group, sandbox: createGroupSandbox(sandbox) },
      },
    };
  }
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Middleware that enables the experimental durable `step.sandbox` API.
 *
 * The direct `inngest.sandboxes` client does not require this middleware.
 *
 * @example
 * ```ts
 * import { sandboxMiddleware } from "inngest/experimental";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   middleware: [sandboxMiddleware()],
 * });
 * ```
 */
export const sandboxMiddleware = () => SandboxMiddleware;
