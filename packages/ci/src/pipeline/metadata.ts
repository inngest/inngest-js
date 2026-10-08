/**
 * Run metadata: the `userland.inngest-ci` metadata attached to runs and steps, so
 * Inngest can tell a run is a CI run and see how `@inngest/ci` is used.
 *
 * Metadata rides on steps CI already runs, so it adds no trace rows. Only a
 * pipeline with its check turned off has no such step, and gets two of its own.
 *
 * @module
 */

import { getAsyncCtx } from "inngest/experimental";
import type { CheckConclusion } from "../types.ts";
import { errorMessage } from "../util.ts";
import { version } from "../version.ts";
import { ciStep, traceName } from "./names.ts";
import type { CiRunScope } from "./scope.ts";
import { apiNames } from "./scope.ts";

/**
 * The metadata kind everything here is attached under. It moves to
 * `inngest.ci` once the backend allows that kind.
 */
export const metadataKind = "userland.inngest-ci";

/** What a step is for, attached to the step that does it. */
export interface StepTag {
  kind: "job" | "check" | "cache";
  /** The job's path. Left out for the pipeline's own check. */
  job?: string;
}

/** What a step records about itself, on top of its tag. */
export interface StepMetadata extends Partial<StepTag> {
  /** A short sentence for what the step sets out to do, written before the work. */
  intent?: string;
  /** What actually happened, in a few small fields. No secrets or output bodies. */
  outcome?: Record<string, unknown>;
}

/**
 * What's known when the run starts: which package, whether it's a local run,
 * and which repository, ref and commit it's for. The pipeline, its triggers
 * and the event are already on the run, as the function and its trigger.
 */
export const runStartMetadata = (run: CiRunScope): Record<string, unknown> => {
  const { repo } = run;

  return {
    package: "@inngest/ci",
    version,
    local: run.ci.isDev() || Boolean(repo?.local),
    ...(repo
      ? {
          repo: repo.fullName,
          ...(repo.ref ? { ref: repo.ref } : {}),
          ...(repo.sha ? { sha: repo.sha } : {}),
          ...(repo.pullRequest ? { pullRequest: repo.pullRequest.number } : {}),
        }
      : {}),
  };
};

/**
 * What's known when the run ends: how it concluded in CI terms (a skipped
 * pipeline is a successful run), how its jobs fared and which APIs it called.
 * The run's own duration is already tracked by Inngest.
 */
export const runEndMetadata = (
  run: CiRunScope,
  conclusion: CheckConclusion,
): Record<string, unknown> => {
  const count = (
    matches: (summary: CiRunScope["summaries"][number]) => boolean,
  ) => {
    return run.summaries.filter(matches).length;
  };

  return {
    conclusion,
    jobs: {
      total: run.summaries.length,
      passed: count((summary) => {
        return summary.conclusion === "success" && !summary.cached;
      }),
      failed: count((summary) => {
        return (
          summary.conclusion === "failure" || summary.conclusion === "timed_out"
        );
      }),
      cached: count((summary) => {
        return Boolean(summary.cached);
      }),
      skipped: count((summary) => {
        return summary.conclusion === "skipped";
      }),
      cancelled: count((summary) => {
        return summary.conclusion === "cancelled";
      }),
    },
    apis: Object.fromEntries(
      apiNames.map((name) => {
        return [name, run.apis[name]];
      }),
    ),
  };
};

/** All that tagging needs of a run: somewhere to warn. */
export type Loggable = { ci: Pick<CiRunScope["ci"], "logger"> };

/**
 * Attach metadata to the step whose callback is running: `runValues` to the
 * run, and `step` to the step itself.
 *
 * It only queues the update on the step's own result, so it adds no request,
 * and a step that's already memoized never runs its callback again, so nothing
 * is sent twice on replay. It must never fail the step, so anything that goes
 * wrong is a warning.
 */
export const tagStep = async (
  run: Loggable,
  step?: StepMetadata,
  runValues?: Record<string, unknown>,
): Promise<void> => {
  try {
    const execution = (await getAsyncCtx())?.execution;
    const stepId = execution?.executingStep?.id;

    if (!execution || !stepId) {
      return;
    }

    if (runValues) {
      execution.instance.addMetadata(
        stepId,
        metadataKind,
        "run",
        "merge",
        runValues,
      );
    }

    if (step) {
      execution.instance.addMetadata(stepId, metadataKind, "step", "merge", {
        ...step,
      });
    }
  } catch (error) {
    run.ci.logger?.warn(
      { error },
      "Couldn't attach userland.inngest-ci metadata",
    );
  }
};

/** The longest a string in a step's outcome gets before it's cut. */
const maxOutcomeString = 200;

/** The most items of a list a step's outcome keeps. */
const maxOutcomeItems = 10;

/** Cut a string to a length that reads in a trace, ending in an ellipsis. */
export const shorten = (text: string, max = maxOutcomeString): string => {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Keep an outcome compact: long strings are cut and long lists trimmed. */
const compact = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") {
    return shorten(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, maxOutcomeItems).map((item) => {
      return compact(item, depth + 1);
    });
  }

  if (value && typeof value === "object" && depth < 3) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        return [key, compact(item, depth + 1)];
      }),
    );
  }

  return value;
};

/** What a CI step's callback is given to say what happened. */
export interface StepNote {
  /** Say more exactly what the step set out to do, once that's known. */
  intent: (text: string) => void;
  /** Record what the step did. Called again, it adds to what was said. */
  outcome: (values: Record<string, unknown>) => void;
}

/** What every step CI generates says about itself. */
export interface CiStepSpec {
  /** A short sentence for what the step sets out to do. */
  intent: string;
  /** The step's tag, when it has one. */
  tag?: StepTag;
  /** Values for the run's own metadata, for a step that carries them. */
  runValues?: () => Record<string, unknown>;
}

/**
 * Run a CI step's work and record its `intent` and `outcome` on the step.
 *
 * Both go in one update when the work ends, so a step is never left with an
 * intent and no outcome. A step that throws still records its intent, with the
 * error's first line as its outcome, since the SDK carries metadata on a
 * failed step too. The error is thrown on, unchanged.
 */
export const withNotes = async <T>(
  run: Loggable,
  spec: CiStepSpec,
  work: (note: StepNote) => Promise<T> | T,
): Promise<T> => {
  let outcome: Record<string, unknown> = {};
  let intent = spec.intent;

  const note: StepNote = {
    intent: (text) => {
      intent = text;
    },
    outcome: (values) => {
      outcome = { ...outcome, ...values };
    },
  };

  try {
    const result = await work(note);

    await tagStep(
      run,
      {
        ...spec.tag,
        intent: shorten(intent),
        outcome: compact(outcome) as Record<string, unknown>,
      },
      spec.runValues?.(),
    );

    return result;
  } catch (error) {
    await tagStep(
      run,
      {
        ...spec.tag,
        intent: shorten(intent),
        outcome: compact({
          ...outcome,
          error: errorMessage(error).split("\n")[0] ?? "",
        }) as Record<string, unknown>,
      },
      spec.runValues?.(),
    );

    throw error;
  }
};

/**
 * Run `work` as one of CI's own steps, with its `intent` and `outcome` on the
 * step's `userland.inngest-ci` metadata. Every step CI generates goes through
 * this, so none is left unexplained.
 *
 * ```ts
 * await ciRun(
 *   run,
 *   {
 *     step: ciStep(id, name),
 *     intent: "Look up the cached snapshot for `install`",
 *   },
 *   async (note) => {
 *     const hit = await find();
 *
 *     note.outcome({ found: Boolean(hit) });
 *
 *     return hit ?? null;
 *   },
 * );
 * ```
 */
export const ciRun = <T>(
  run: CiRunScope,
  spec: CiStepSpec & {
    /** The step's ID and name, as `run.step.run` takes them. */
    step: { id: string; name: string };
  },
  work: (note: StepNote) => Promise<T> | T,
): Promise<T> => {
  return run.step.run(spec.step, () => {
    return withNotes(run, spec, work);
  }) as Promise<T>;
};

/**
 * A step of its own that only carries run metadata and returns the time, for
 * a pipeline whose check is off and so has no step to ride on.
 */
export const metadataStep = (
  run: CiRunScope,
  id: string,
  runValues: () => Record<string, unknown>,
): Promise<number> => {
  return ciRun(
    run,
    {
      step: ciStep(id, traceName.recordRunDetails),
      intent: "Record this run's details",
      runValues,
    },
    () => {
      return Date.now();
    },
  );
};
