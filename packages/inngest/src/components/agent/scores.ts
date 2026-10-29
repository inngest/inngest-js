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
import { type Inngest, internalLoggerSymbol } from "../Inngest.ts";
import { scoreMetadataKind } from "../InngestMetadata.ts";
import { validateStepScoreOptions } from "../InngestScore.ts";

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
  | "agent.tool_ms"
  | "agent.tool_error"
  | "agent.first_output_ms"
  | "agent.output_gap_ms"
  | "agent.stopped";

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
 * What the body gets as `agent`: `score()` for your own scores.
 */
export interface AgentScores {
  /**
   * EXPERIMENTAL: Records a score of any name. Inside a step (a tool, or the
   * model function) it is written on that step with the step's result, once.
   * Outside a step it sets a score on the run, which is written live: a replay
   * writes the same value again, so call it with values that do not change
   * between replays. A score is best effort: if the server refuses it, for
   * example because it does not support scores, a warning is logged once and
   * the run goes on.
   *
   * @example
   * ```ts
   * agent.score("support.escalated", ticket.escalated);
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
}

/**
 * Makes the `agent.score()` of one agent run. `client` writes the scores
 * made outside a step.
 */
export const createAgentScores = (client: Inngest.Any): AgentScores => {
  let warned = false;

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

      try {
        await client.score({ name, value });
      } catch (error) {
        // A score is never worth failing or retrying a run, so a server that
        // refuses it is told about once and then ignored.
        if (!warned) {
          warned = true;
          client[internalLoggerSymbol].warn(
            { error: error instanceof Error ? error.message : String(error) },
            "Could not record an agent score; the server may not support scores. Scores are skipped when they fail.",
          );
        }
      }
    },
  };
};
