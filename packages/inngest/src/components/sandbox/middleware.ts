import type { Inngest } from "../Inngest.ts";
import { Middleware } from "../middleware/middleware.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { createSandboxTools, executeSandboxOperation } from "./durable.ts";
import { parseSandboxOperation, type SandboxRawTool } from "./protocol.ts";
import {
  type DurableSandboxTools,
  SandboxError,
  SandboxValidationError,
  sandboxProtocolVersion,
} from "./types.ts";

type SandboxStepExtension = {
  sandbox: DurableSandboxTools;
};

const executeAsStep = async (
  client: Inngest.Any,
  operation: unknown,
): Promise<unknown> => {
  try {
    return await executeSandboxOperation(client.sandboxes, operation);
  } catch (error) {
    if (error instanceof SandboxError) {
      const cause = {
        protocolVersion: error.protocolVersion,
        action: error.action,
        code: error.code,
        message: error.message,
        ...(error.status !== undefined && { status: error.status }),
        ...(error.sandboxId !== undefined && {
          sandboxId: error.sandboxId,
        }),
        ...(error.processId !== undefined && {
          processId: error.processId,
        }),
        ...(error.snapshotId !== undefined && {
          snapshotId: error.snapshotId,
        }),
        ambiguous: error.ambiguous,
        retryable: error.retryable,
        ...(error.requestId !== undefined && {
          requestId: error.requestId,
        }),
        details: [...error.details],
      };
      if (error.retryable) {
        const retryableError = new Error(error.message, { cause });
        retryableError.name = error.name;
        throw retryableError;
      }
      throw new NonRetriableError(error.message, { cause });
    }
    if (error instanceof SandboxValidationError) {
      throw new NonRetriableError(error.message, {
        cause: {
          protocolVersion: sandboxProtocolVersion,
          type: "sandbox_validation_error" as const,
          message: error.message,
        },
      });
    }
    throw error;
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
    };
  } {
    const rawTool: SandboxRawTool = (idOrOptions, operation) => {
      return arg.ctx.step.run(
        idOrOptions,
        (input) => executeAsStep(this.client, input),
        parseSandboxOperation(operation),
      );
    };

    return {
      ...arg,
      ctx: {
        ...arg.ctx,
        step: {
          ...arg.ctx.step,
          sandbox: createSandboxTools(() => rawTool),
        },
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
