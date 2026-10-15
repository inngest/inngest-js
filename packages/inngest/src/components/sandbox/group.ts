/**
 * @module
 * `group.sandbox()`: a sandbox that lives for the length of a callback, shown
 * as one `sandbox` group in the trace.
 */

import { getAsyncCtxSync } from "../execution/als.ts";
import { withSpan } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { StepError } from "../StepError.ts";
import type {
  DurableSandbox,
  DurableSandboxTools,
  SandboxCreateOptions,
} from "./types.ts";

/**
 * The options of `step.sandbox.create()`, plus the ID of the group and of its
 * create step.
 */
export type GroupSandboxOptions = SandboxCreateOptions & { id: string };

export type GroupSandboxOptionsOrId = string | GroupSandboxOptions;

export type GroupSandbox = <T>(
  idOrOptions: GroupSandboxOptionsOrId,
  callback: (sandbox: DurableSandbox) => Promise<T>,
) => Promise<T>;

/**
 * Build `group.sandbox()` on top of `step.sandbox.create()`.
 */
export const createGroupSandbox = (
  tools: DurableSandboxTools,
): GroupSandbox => {
  return (idOrOptions, callback) => {
    const { id, ...options } =
      typeof idOrOptions === "string"
        ? {
            id: idOrOptions,
            // A run's sandboxes need names that no other run shares
            name: `${getAsyncCtxSync()?.execution?.ctx.runId}-${idOrOptions}`,
            vcpu: 2,
            memoryMb: 2048,
          }
        : idOrOptions;

    return withSpan(
      { id, name: `Sandbox ${id}`, kind: "sandbox" },
      async () => {
        const sandbox = await tools.create(id, options);

        try {
          return await callback(sandbox);
        } catch (error) {
          // The sandbox is destroyed below, so a retry couldn't reuse it
          if (
            error instanceof NonRetriableError ||
            error instanceof StepError
          ) {
            throw error;
          }

          throw new NonRetriableError(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        } finally {
          await sandbox[Symbol.asyncDispose]();
        }
      },
    );
  };
};
