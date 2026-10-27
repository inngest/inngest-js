/**
 * @module
 * `callRawTool`: runs one sandbox operation as a step through the app's raw
 * tool, and turns what a failed step throws into the sandbox's own errors.
 * It is the only way the durable facade and managed commands run an operation.
 */

import type { StepOptionsOrId } from "../../types.ts";
import { getStepOptions, withSpan } from "../InngestStepTools.ts";
import { StepError } from "../StepError.ts";
import {
  findSandboxErrorOptions,
  findSandboxValidationError,
  type SandboxOperationForAction,
  type SandboxRawToolResolver,
  type SandboxResultForAction,
  validateSandboxResult,
} from "./protocol.ts";
import type { SandboxToolsRequest } from "./tools.ts";
import { commandSpan, namedStep } from "./trace.ts";
import {
  type SandboxAction,
  SandboxError,
  SandboxValidationError,
} from "./types.ts";

/**
 * Run an operation as a step. With `finish`, the step also does that work and
 * its output is what `finish` returns, so a replay returns it unchanged.
 */
export const callRawTool = async <
  A extends SandboxAction,
  T = SandboxResultForAction<A>,
>(
  rawToolResolver: SandboxRawToolResolver,
  idOrOptions: StepOptionsOrId,
  operation: SandboxOperationForAction<A>,
  finish?: (result: SandboxResultForAction<A>) => T | Promise<T>,
  tools?: SandboxToolsRequest,
): Promise<T> => {
  try {
    const rawTool = await rawToolResolver();
    const named = namedStep(operation, idOrOptions);
    // A command with tools takes several steps, so a caller's own span goes
    // around all of them, not just the first
    const { "~span": toolsSpan, ...ungrouped } = getStepOptions(named);
    const step = tools && toolsSpan ? ungrouped : named;
    const span = (tools && toolsSpan) || commandSpan(operation, step);
    // A command is one row, however many steps it takes
    const inSpan = <R>(fn: () => R): R => {
      return span ? withSpan(span, fn) : fn();
    };

    if (tools) {
      return validateSandboxResult(
        operation,
        await inSpan(() => {
          return rawTool(step, operation, undefined, tools);
        }),
      ) as T;
    }

    if (finish) {
      return (await inSpan(() => {
        return rawTool(step, operation, (result) => {
          return finish(validateSandboxResult(operation, result));
        });
      })) as T;
    }

    return validateSandboxResult(
      operation,
      await inSpan(() => {
        return rawTool(step, operation);
      }),
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
