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
import type { ExperimentRef } from "../../../types.ts";

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
 * Options of `score()`.
 */
export interface AgentScoreOptions {
  /**
   * Credits the scores to this experiment variant, as
   * `inngest.score.experiment()` does. Inside a `group.experiment()` variant
   * the variant is picked up on its own and this is not needed.
   */
  experiment?: ExperimentRef;
}

/**
 * The call forms of `score()`: one name and value, or a record of them.
 */
export interface AgentScoreFn {
  (
    name: string,
    value: number | boolean,
    options?: AgentScoreOptions,
  ): Promise<void>;
  (
    scores: Record<string, number | boolean>,
    options?: AgentScoreOptions,
  ): Promise<void>;
}

const parseScoreArgs = (
  args: [
    string | Record<string, number | boolean>,
    (number | boolean | AgentScoreOptions)?,
    AgentScoreOptions?,
  ],
) => {
  const [first, second, third] = args;
  const entries: [string, number | boolean][] =
    typeof first === "string"
      ? [[first, second as number | boolean]]
      : Object.entries(first ?? {});
  const options = (typeof first === "string" ? third : second) as
    | AgentScoreOptions
    | undefined;

  if (typeof first !== "string" && (typeof first !== "object" || !first)) {
    throw new Error("score needs a name and a value, or a record of scores");
  }

  for (const [name, value] of entries) {
    validateStepScoreOptions({ name, value });

    if (name.startsWith(frameworkPrefix)) {
      throw new Error(
        `score name "${name}" starts with "${frameworkPrefix}", which is kept for the scores the framework writes`,
      );
    }
  }

  return { entries, options };
};

/**
 * The variant to credit: the one whose `group.experiment()` callback is
 * running, else the one the caller named. Undefined when neither.
 */
const experimentToCredit = (
  options: AgentScoreOptions | undefined,
): ExperimentRef | undefined => {
  const inVariant = getAsyncCtxSync()?.execution?.experimentContext;

  if (inVariant) {
    return {
      experimentName: inVariant.experimentName,
      variant: inVariant.variant,
    };
  }

  return options?.experiment;
};

/**
 * Writes scores run-scoped to an experiment variant. Best effort.
 */
const writeToExperiment = async (
  client: Inngest.Any,
  entries: [string, number | boolean][],
  experiment: ExperimentRef,
) => {
  const runId = getAsyncCtxSync()?.execution?.ctx?.runId;

  for (const [name, value] of entries) {
    try {
      await client.score.experiment({ name, value, experiment, runId });
    } catch (error) {
      client[internalLoggerSymbol].warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Could not record an agent score for an experiment; the server may not support scores. Scores are skipped when they fail.",
      );
    }
  }
};

/**
 * The `score` of one agent run, and the `flush` that waits for the scores
 * still being written.
 */
export interface AgentScore {
  /**
   * EXPERIMENTAL: Scores the run: `score("quality", 1)`, or several at once
   * with a record: `score({ "train.pass_rate": 0.9, "holdout.pass_rate": 0.88 })`.
   * Written once wherever it is called. Inside a step (a tool, or the model
   * function) it rides on that step's result, with no extra step. Outside a
   * step it is a memoized step, one for the whole record, whose id comes from
   * the names, so a replay does not write it again. It is best effort: a score
   * the server refuses logs a warning and the run goes on. An un-awaited call
   * is still written before the run ends.
   *
   * Inside a `group.experiment()` variant the scores also credit that variant,
   * written run-scoped (a score made inside a step still rides on the step).
   * Outside a variant they credit only the `experiment` in `options`.
   *
   * @example
   * ```ts
   * await score("support.escalated", ticket.escalated);
   * await score({ "train.pass_rate": 0.9, "holdout.pass_rate": 0.88 });
   * await score("quality", 1, { experiment: ref });
   * ```
   */
  score: AgentScoreFn;

  /**
   * Waits for every score called so far, awaited or not. The run calls it
   * before it ends.
   */
  flush(): Promise<void>;
}

/**
 * The `score` of a tool's context, and `score` from `inngest/experimental/agents`:
 * the same function as the handler's, found through the run's async context,
 * so code anywhere in an agent run can score without passing it down. In an
 * agent run it is the run's own, so the run waits for a score not awaited.
 * Elsewhere it rides on the running step, or does nothing. It checks the name
 * and value either way.
 */
export const toolScore: AgentScoreFn = async (
  ...args: [
    string | Record<string, number | boolean>,
    (number | boolean | AgentScoreOptions)?,
    AgentScoreOptions?,
  ]
) => {
  const bridged = getAsyncCtxSync()?.execution?.agentBridge?.score;

  if (bridged) {
    return (bridged as (...a: typeof args) => Promise<void>)(...args);
  }

  const { entries } = parseScoreArgs(args);

  for (const [name, value] of entries) {
    addStepScore(name, value);
  }
};

/**
 * Makes the `score` of one agent run. `client` writes the scores made outside
 * a step.
 */
export const createAgentScore = (client: Inngest.Any): AgentScore => {
  const pending = new Set<Promise<void>>();

  const write = async (
    entries: [string, number | boolean][],
    experiment: ExperimentRef | undefined,
  ) => {
    // The step answers whether or not the server took the score, so a refused
    // score is never retried and never fails the run.
    await step.run(`score:${entries.map(([n]) => n).join(",")}`, async () => {
      if (experiment) {
        await writeToExperiment(client, entries, experiment);
        return;
      }

      for (const [name, value] of entries) {
        try {
          await client.score({ name, value });
        } catch (error) {
          client[internalLoggerSymbol].warn(
            { error: error instanceof Error ? error.message : String(error) },
            "Could not record an agent score; the server may not support scores. Scores are skipped when they fail.",
          );
        }
      }
    });
  };

  const run = async (
    entries: [string, number | boolean][],
    options: AgentScoreOptions | undefined,
  ) => {
    const experiment = experimentToCredit(options);

    if (entries.map(([n, v]) => addStepScore(n, v)).every(Boolean)) {
      if (experiment) {
        // Run scoped, so the experiment view reads it, even from inside a step.
        await writeToExperiment(client, entries, experiment);
      }

      return;
    }

    await write(entries, experiment);
  };

  const score: AgentScoreFn = async (
    ...args: [
      string | Record<string, number | boolean>,
      (number | boolean | AgentScoreOptions)?,
      AgentScoreOptions?,
    ]
  ) => {
    const { entries, options } = parseScoreArgs(args);

    if (entries.length === 0) {
      return;
    }

    const written = run(entries, options);

    pending.add(written);

    try {
      await written;
    } finally {
      pending.delete(written);
    }
  };

  return {
    score,
    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
};
