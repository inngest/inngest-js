/**
 * @module
 * Cleanup for scoped sandboxes (`await using` and `group.sandbox()`). Each one
 * registers a defer, once its create has succeeded, that destroys the sandbox
 * by ID when the run ends for any reason, including cancel and timeout, and
 * aborts it once the scope has destroyed the sandbox itself, so a run that
 * finishes normally starts no extra run.
 *
 * A run cancelled after the create finished and before the defer was
 * registered, which happens in the request that follows the create step, leaves
 * the sandbox to its own running timeout.
 */

import type { DeferHandle } from "../../types.ts";
import { createDefer, type DeferredFunction } from "../DeferredFunction.ts";
import type { Inngest } from "../Inngest.ts";
import type { DurableSandboxTools, SandboxClient } from "./types.ts";

/**
 * The sandbox a cleanup run destroys: one the run created, by its ID.
 */
export type SandboxCleanupTarget = {
  sandboxId: string;
};

/**
 * Registers the cleanup defer for a scope, given the ID of its create step.
 */
export type SandboxCleanupRegistrar = (
  stepId: string,
  target: SandboxCleanupTarget,
) => DeferHandle;

const registrars = new WeakMap<DurableSandboxTools, SandboxCleanupRegistrar>();

const cleanups = new WeakMap<Inngest.Any, DeferredFunction.Any>();

/**
 * Make `registrar` the one scopes of these tools use.
 */
export const setCleanupRegistrar = (
  tools: DurableSandboxTools,
  registrar: SandboxCleanupRegistrar,
): void => {
  registrars.set(tools, registrar);
};

export const cleanupRegistrarOf = (
  tools: DurableSandboxTools,
): SandboxCleanupRegistrar | undefined => {
  return registrars.get(tools);
};

/**
 * Destroy the sandbox of `target`, if it still exists.
 */
const destroyTarget = async (
  sandboxes: SandboxClient,
  target: SandboxCleanupTarget,
): Promise<void> => {
  await (await sandboxes.get(target.sandboxId))?.destroy();
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * The function that destroys the sandboxes of scopes (`await using` and
 * `group.sandbox()`) whose run ended before they could, for example because it
 * was cancelled or timed out.
 *
 * Apps with `sandboxMiddleware()` serve it automatically. Pass it to `serve()`
 * yourself only when you serve functions without the client's middleware.
 *
 * @example
 * ```ts
 * serve({ client: inngest, functions: [coder, createSandboxCleanup(inngest)] });
 * ```
 */
export const createSandboxCleanup = (
  client: Inngest.Any,
): DeferredFunction.Any => {
  const existing = cleanups.get(client);

  if (existing) {
    return existing;
  }

  const cleanup = createDefer(
    client,
    { id: "inngest-sandbox-cleanup" },
    async ({ event, step }) => {
      await step.run("destroy", async () => {
        await destroyTarget(
          client.sandboxes,
          event.data as SandboxCleanupTarget,
        );
      });
    },
  );

  cleanups.set(client, cleanup);

  return cleanup;
};
