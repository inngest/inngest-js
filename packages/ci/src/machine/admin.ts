/**
 * Destroying what a run created in the Sandboxes API, by ID: machine destroys
 * that tolerate what is already gone. Cleanup steps go through this rather than
 * writing the not-found handling again. Nothing here lists the API: a run only
 * ever touches what it holds the ID of.
 *
 * @module
 */

import type { Inngest } from "inngest";
import { isSandboxNotFound } from "../util.ts";

/**
 * Destroy machines by ID. One that is already gone counts for nothing. Any
 * other error is thrown, so the step that calls this retries.
 */
export const destroySandboxes = async (
  client: Inngest.Any,
  ids: Iterable<string>,
): Promise<{ destroyed: number }> => {
  let destroyed = 0;

  for (const id of ids) {
    try {
      const sandbox = await client.sandboxes.get(id);

      if (sandbox) {
        await sandbox.destroy();

        destroyed++;
      }
    } catch (error) {
      if (!isSandboxNotFound(error)) {
        throw error;
      }
    }
  }

  return { destroyed };
};
