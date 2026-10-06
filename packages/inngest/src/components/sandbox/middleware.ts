import { getAsyncCtxSync } from "../execution/als.ts";
import type { Inngest } from "../Inngest.ts";
import { Middleware } from "../middleware/middleware.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { createSandboxTools, executeSandboxOperation } from "./durable.ts";
import {
  getSandboxError,
  parseSandboxOperation,
  type SandboxOperationResultV1,
  type SandboxOperationV1,
  type SandboxRawTool,
} from "./protocol.ts";
import {
  getSandboxStatement,
  type SandboxStatementScope,
} from "./statement.ts";
import {
  type SandboxStepTrace,
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
  sandbox: DurableSandboxTools;
};

/**
 * Attach `inngest.sandbox` metadata to the step that's executing, describing
 * the sandbox action for the trace. Tracing must never fail the step.
 */
const describeStep = (
  operation: unknown,
  trace: SandboxStepTrace,
  resolveStatementId: (operation: SandboxOperationV1) => string | undefined,
  statementScope: SandboxStatementScope | undefined,
  outcome: { result: unknown } | { error: unknown },
): void => {
  try {
    const execution = getAsyncCtxSync()?.execution;
    const step = execution?.executingStep;
    if (!execution || !step?.id || !step.hashedId) {
      return;
    }

    const parsed = parseSandboxOperation(operation);
    const statementId = trace.statementOperation
      ? resolveStatementId(trace.statementOperation)
      : undefined;

    execution.instance.addMetadata(
      step.id,
      sandboxMetadataKind,
      "step",
      "merge",
      {
        ...sandboxTraceMetadata({
          operation: parsed,
          trace,
          stepId: step.hashedId,
          ...(statementId !== undefined && { statementId }),
          ...(statementScope && { statementScope }),
          outcome:
            "result" in outcome
              ? { result: outcome.result as SandboxOperationResultV1 }
              : { error: getSandboxError(outcome.error) },
        }),
      },
    );
  } catch {
    // An operation that fails validation has nothing to describe.
  }
};

const executeAsStep = async (
  client: Inngest.Any,
  operation: unknown,
  trace: SandboxStepTrace | undefined,
  resolveStatementId: (operation: SandboxOperationV1) => string | undefined,
  statementScope: SandboxStatementScope | undefined,
): Promise<unknown> => {
  try {
    const result = await executeSandboxOperation(client.sandboxes, operation);
    if (trace) {
      describeStep(operation, trace, resolveStatementId, statementScope, {
        result,
      });
    }
    return result;
  } catch (error) {
    if (trace) {
      describeStep(operation, trace, resolveStatementId, statementScope, {
        error,
      });
    }
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

  /**
   * The step ID each sandbox operation was planned or memoized under, so an
   * internal step can name the statement step it serves. Keyed by the
   * operation object the facade passed to `step.run`, which is recreated on
   * every request, including replays of memoized steps.
   */
  private readonly stepIds = new WeakMap<object, string>();

  override transformStepInput(
    arg: Middleware.TransformStepInputArgs,
  ): Middleware.TransformStepInputArgs {
    const [operation] = arg.input;
    if (
      arg.stepInfo.stepType === "run" &&
      typeof operation === "object" &&
      operation !== null &&
      "protocolVersion" in operation &&
      "action" in operation
    ) {
      this.stepIds.set(operation, arg.stepInfo.hashedId);
    }
    return arg;
  }

  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs & {
    ctx: Middleware.TransformFunctionInputArgs["ctx"] & {
      step: Middleware.TransformFunctionInputArgs["ctx"]["step"] &
        SandboxStepExtension;
    };
  } {
    const resolveStatementId = (operation: SandboxOperationV1) =>
      this.stepIds.get(operation);
    const rawTool: SandboxRawTool = (idOrOptions, operation, trace) => {
      // Read the scope where the facade was called, since the step's handler
      // may run later, outside it.
      const statementScope = getSandboxStatement();
      return arg.ctx.step.run(
        idOrOptions,
        (input) =>
          executeAsStep(
            this.client,
            input,
            trace,
            resolveStatementId,
            statementScope,
          ),
        operation,
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
