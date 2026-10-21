/**
 * @module
 * Cleanup for scoped sandboxes (`await using` and `group.sandbox()`). Each one
 * registers a defer that destroys the sandbox when the run ends for any reason,
 * including cancel and timeout, and aborts it once the scope has destroyed the
 * sandbox itself, so a run that finishes normally starts no extra run.
 */

import type { DeferHandle } from "../../types.ts";
import { createDefer, type DeferredFunction } from "../DeferredFunction.ts";
import type { Inngest } from "../Inngest.ts";
import type { DurableSandboxTools, SandboxClient } from "./types.ts";

/**
 * The sandbox a cleanup run destroys: by ID when it is known, else by name.
 */
export type SandboxCleanupTarget = {
  name: string;
  sandboxId?: string;
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
  if (target.sandboxId) {
    await (await sandboxes.get(target.sandboxId))?.destroy();

    return;
  }

  let cursor: string | undefined;

  do {
    const page = await sandboxes.list({ limit: 100, cursor });
    const found = page.items.find((sandbox) => {
      return sandbox.name === target.name;
    });

    if (found) {
      await found.destroy();

      return;
    }

    cursor = page.page.hasMore ? page.page.cursor : undefined;
  } while (cursor);
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
