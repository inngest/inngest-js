/**
 * @module
 * EXPERIMENTAL: the scores an agent writes about itself. A score is a number
 * on a step or a run, named `agent.<metric>` for the ones the framework writes
 * (`agent.model_ms`, `agent.tool_error`, ...) and anything you like for your
 * own. The framework adds no steps for them: each rides on a step that already
 * runs, in the metadata that step sends with its result, so it is written once
 * when the step really runs and never again on replay. Rolling them up (the
 * average, the 90th percentile, a rate) is left to Insights.
 */
import { getAsyncCtxSync } from "../execution/als.ts";
import type { Inngest } from "../Inngest.ts";
import { scoreMetadataKind } from "../InngestMetadata.ts";
import { validateStepScoreOptions } from "../InngestScore.ts";

/**
 * Scores the step that is running now, as part of that step. Does nothing
 * outside a step, or for a value that is not a finite number or a boolean. It
 * never throws: a score is never worth failing a model call. Returns whether
 * the score was added to a step.
 */
export const scoreThisStep = (
  /**
   * Score name, such as `agent.model_ms`.
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
 * What the body gets as `agent`: `score()` for your own scores.
 */
export interface AgentScores {
  /**
   * EXPERIMENTAL: Records a score of any name. Inside a step (a tool, or the
   * model function) it is written on that step with the step's result, once.
   * Outside a step it sets a score on the run, which is written live: a replay
   * writes the same value again, so call it with values that do not change
   * between replays.
   *
   * @example
   * ```ts
   * agent.score("support.escalated", ticket.escalated);
   * ```
   */
  score(
    /**
     * Any name without control characters or single quotes, 128 bytes at most.
     */
    name: string,
    /**
     * A finite number, or a boolean.
     */
    value: number | boolean,
  ): Promise<void>;
}

/**
 * Makes the `agent.score()` of one agent run. `client` writes the scores
 * made outside a step.
 */
export const createAgentScores = (client: Inngest.Any): AgentScores => {
  return {
    async score(name, value) {
      validateStepScoreOptions({ name, value });

      if (scoreThisStep(name, value)) {
        return;
      }

      await (client as Inngest).score({ name, value });
    },
  };
};
