/**
 * @module
 * EXPERIMENTAL: the function that hosts a shared tool. It has an `invoke()`
 * trigger built from the tool's `input`, runs the tool's `run` with the usual
 * step tools, and has the tool's card.
 */

import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import { toolSourceOf } from "../../../components/sandbox/callSite.ts";
import {
  isToolError,
  type SharedTool,
  type SharedToolContext,
} from "../../../components/sandbox/tools.ts";
import { invoke } from "../../../components/triggers/triggers.ts";
import { type AgentCard, cardOf } from "../discovery/discovery.ts";

/**
 * Makes the function that hosts `shared` in the app of `client`, and its card.
 */
export const createSharedToolFunction = (
  client: Inngest.Any,
  shared: SharedTool,
): { fn: InngestFunction.Any; card: AgentCard } => {
  const input = shared.input as Parameters<typeof invoke>[0];
  const description = shared.description ?? shared.card?.description;
  const run = shared.run as (
    input: unknown,
    ctx: SharedToolContext,
  ) => Promise<unknown>;

  const fn = client.createFunction(
    {
      id: shared.id,
      ...(description !== undefined && { description }),
      triggers: [invoke(input)],
    },
    async ({ event, step, logger, runId, attempt }) => {
      // The trigger's schema checks callers that name the function; a plain
      // event does not pass through it, so the body checks again.
      const checked = await input["~standard"].validate(event.data);

      if (checked.issues) {
        throw new NonRetriableError(
          `Invalid input for shared tool "${shared.id}": ${checked.issues
            .map((issue) => {
              return issue.message;
            })
            .join("; ")}`,
        );
      }

      const value = await run(checked.value, {
        step,
        logger,
        runId,
        event,
        attempt,
      });

      if (!shared.output || isToolError(value)) {
        return value;
      }

      const result = await shared.output["~standard"].validate(value);

      if (result.issues) {
        throw new NonRetriableError(
          `Shared tool "${shared.id}" returned an invalid result: ${result.issues
            .map((issue) => {
              return issue.message;
            })
            .join("; ")}`,
        );
      }

      return result.value;
    },
  );

  return {
    fn,
    card: cardOf(client.id, shared.id, fn, {
      card: shared.card,
      description: shared.description,
      kind: "tool",
      ...(toolSourceOf(shared) && { source: toolSourceOf(shared) }),
    }),
  };
};
