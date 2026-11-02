/**
 * @module
 * EXPERIMENTAL: the scores an agent writes about itself. A score is a number
 * on a step or a run, named `agent.<metric>` for the ones the framework writes
 * (`agent.model_ms`, `agent.tool_error`, ...) and anything you like for your
 * own. The framework's own scores add no steps: each rides on a step that already
 * runs, in the metadata that step sends with its result, so it is written once
 * when the step really runs and never again on replay. Your own `score()` does
 * the same inside a step, and is one memoized step outside. Rolling them up (the
 * average, the 90th percentile, a rate) is left to Insights.
 */
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import {
  type Inngest,
  internalLoggerSymbol,
} from "../../../components/Inngest.ts";
import { scoreMetadataKind } from "../../../components/InngestMetadata.ts";
import { validateStepScoreOptions } from "../../../components/InngestScore.ts";
import { step } from "../../../components/InngestStepTools.ts";

/**
 * The names of the scores the framework writes. Your own scores may not start
 * with `agent.`, so they cannot overwrite these.
 */
export type AgentScoreName =
  | "agent.model_ms"
  | "agent.tool_calls"
  | "agent.steers"
  | "agent.input_tokens"
  | "agent.output_tokens"
  | "agent.cache_read_tokens"
  | "agent.cache_write_tokens"
  | "agent.tool_ms"
  | "agent.tool_error";

const frameworkPrefix = "agent.";

/**
 * Scores the step that is running now, as part of that step. Does nothing
 * outside a step, or for a value that is not a finite number or a boolean. It
 * never throws: a score is never worth failing a model call. Returns whether
 * the score was added to a step.
 */
const addStepScore = (
  /**
   * Any valid score name.
   */
  name: string,
  /**
   * The number, or a boolean for a yes or no.
   */
  value: number | boolean,
) => {
  const execution = getAsyncCtxSync()?.execution;
  const running = execution?.executingStep;

  if (
    !execution ||
    !running?.id ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    return false;
  }

  try {
    return execution.instance.addMetadata(
      running.id,
      scoreMetadataKind(name),
      "step",
      "set",
      { value },
    );
  } catch {
    return false;
  }
};

/**
 * Scores the step that is running now with one of the framework's scores.
 */
export const scoreThisStep = (
  /**
   * The score.
   */
  name: AgentScoreName,
  /**
   * The number, or a boolean for a yes or no.
   */
  value: number | boolean,
) => {
  return addStepScore(name, value);
};

/**
 * The `score` of one agent run, and the `flush` that waits for the scores
 * still being written.
 */
export interface AgentScore {
  /**
   * EXPERIMENTAL: Scores the run: `score("quality", 1)`. Written once wherever
   * it is called. Inside a step (a tool, or the model function) it rides on
   * that step's result, with no extra step. Outside a step it is a memoized
   * step whose id comes from the name, so a replay does not write it again.
   * It is best effort: a score the server refuses logs a warning and the run
   * goes on. An un-awaited call is still written before the run ends.
   *
   * @example
   * ```ts
   * await score("support.escalated", ticket.escalated);
   * ```
   */
  score(
    /**
     * Any name without control characters or single quotes, 128 bytes at
     * most, and not starting with `agent.`, which the framework keeps for its
     * own scores.
     */
    name: string,
    /**
     * A finite number, or a boolean.
     */
    value: number | boolean,
  ): Promise<void>;

  /**
   * Waits for every score called so far, awaited or not. The run calls it
   * before it ends.
   */
  flush(): Promise<void>;
}

/**
 * Makes the `score` of one agent run. `client` writes the scores made outside
 * a step.
 */
export const createAgentScore = (client: Inngest.Any): AgentScore => {
  const pending = new Set<Promise<void>>();

  const write = async (name: string, value: number | boolean) => {
    // The step answers whether or not the server took the score, so a refused
    // score is never retried and never fails the run.
    await step.run(`score:${name}`, async () => {
      try {
        await client.score({ name, value });
      } catch (error) {
        client[internalLoggerSymbol].warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Could not record an agent score; the server may not support scores. Scores are skipped when they fail.",
        );
      }
    });
  };

  return {
    async score(name, value) {
      validateStepScoreOptions({ name, value });

      if (name.startsWith(frameworkPrefix)) {
        throw new Error(
          `score name "${name}" starts with "${frameworkPrefix}", which is kept for the scores the framework writes`,
        );
      }

      if (addStepScore(name, value)) {
        return;
      }

      const written = write(name, value);

      pending.add(written);

      try {
        await written;
      } finally {
        pending.delete(written);
      }
    },
    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
};
