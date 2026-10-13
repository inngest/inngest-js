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

const retriesRemain = (): boolean => {
  const ctx = getAsyncCtxSync()?.execution?.ctx;

  return ctx?.maxAttempts !== undefined && ctx.attempt < ctx.maxAttempts - 1;
};

/**
 * Whether an error ends the sandbox. A final error, or any error on the last
 * attempt, does. Any other error is about to be retried, and the retry replays
 * the memoized creation, so the sandbox must stay alive for it.
 */
const isFinal = (error: unknown): boolean => {
  return (
    error instanceof StepError ||
    error instanceof NonRetriableError ||
    !retriesRemain()
  );
};

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
        let failure: { error: unknown } | undefined;

        try {
          return await callback(sandbox);
        } catch (error) {
          failure = { error };

          throw error;
        } finally {
          if (!failure || isFinal(failure.error)) {
            await sandbox[Symbol.asyncDispose]();
          }
        }
      },
    );
  };
};
