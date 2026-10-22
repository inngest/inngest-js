/**
 * @module
 * `group.sandbox()`: a sandbox that lives for the length of a callback, shown
 * as one `sandbox` group in the trace.
 */

import type { StepOptions, StepOptionsOrId } from "../../types.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import { withSpan } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { StepError } from "../StepError.ts";
import { withCurrentSandbox } from "./dollar.ts";
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

  return !ctx?.maxAttempts || ctx.attempt < ctx.maxAttempts - 1;
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
 * Destroy a sandbox in a step. A destroy that failed for good is on the trace
 * as a warning, and must not change the outcome of the run.
 */
export const destroyQuietly = async (
  sandbox: DurableSandbox,
  idOrOptions: StepOptionsOrId,
): Promise<void> => {
  try {
    await sandbox.destroy(idOrOptions);
  } catch (error) {
    if (!(error instanceof StepError)) {
      throw error;
    }
  }
};

/**
 * The options of a sandbox created from just an ID. Each run's sandboxes need
 * names that no other run shares.
 */
export const sandboxDefaults = (id: string) => {
  return {
    id,
    name: `${getAsyncCtxSync()?.execution?.ctx.runId}-${id}`,
    vcpu: 2,
    memoryMb: 2048,
  };
};

/**
 * Run `callback` with a new sandbox inside a span of the given kind, and
 * destroy the sandbox when it ends. The span is named `name`, or else for its
 * ID, after `title` if there is one. `steps` adds options, such as a name, to the create and
 * destroy steps.
 */
export const withSandbox = <T>(
  tools: DurableSandboxTools,
  span: { kind: string; title?: string; name?: string },
  idOrOptions: GroupSandboxOptionsOrId,
  callback: (sandbox: DurableSandbox) => Promise<T>,
  steps: {
    create?: Omit<StepOptions, "id">;
    destroy?: Omit<StepOptions, "id">;
  } = {},
): Promise<T> => {
  const { id, ...options } =
    typeof idOrOptions === "string"
      ? sandboxDefaults(idOrOptions)
      : idOrOptions;

  return withSpan(
    {
      id,
      name: span.name ?? (span.title ? `${span.title} ${id}` : id),
      kind: span.kind,
    },
    async () => {
      const sandbox = await tools.create({ ...steps.create, id }, options);
      let failure: { error: unknown } | undefined;

      try {
        return await withCurrentSandbox(sandbox, () => {
          return callback(sandbox);
        });
      } catch (error) {
        failure = { error };

        throw error;
      } finally {
        if (!failure || isFinal(failure.error)) {
          await destroyQuietly(sandbox, {
            ...steps.destroy,
            id: `${id}:destroy`,
          });
        }
      }
    },
  );
};

/**
 * Build `group.sandbox()` on top of `step.sandbox.create()`.
 */
export const createGroupSandbox = (
  tools: DurableSandboxTools,
): GroupSandbox => {
  return (idOrOptions, callback) => {
    return withSandbox(
      tools,
      { kind: "sandbox", title: "Sandbox" },
      idOrOptions,
      callback,
    );
  };
};
