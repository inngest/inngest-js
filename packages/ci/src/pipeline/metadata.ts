/**
 * Run metadata: the `userland.inngest-ci` metadata attached to runs and steps, so
 * Inngest can tell a run is a CI run and see how `@inngest/ci` is used.
 *
 * Run values, and each step's intent and outcome, ride on steps CI already
 * runs, so they add no trace rows. Only a pipeline with its check turned off
 * has no such step, and gets two of its own.
 *
 * @module
 */

import type { StepOptions } from "inngest";
import { getAsyncCtx } from "inngest/experimental";
import type { CheckConclusion } from "../types.ts";
import { errorMessage, truncateLabel } from "../util.ts";
import { version } from "../version.ts";
import { ciOrigin, type StepSpec, steps } from "./names.ts";
import type { CiRunScope } from "./scope.ts";
import { apiNames } from "./scope.ts";
import { originOption } from "./spans.ts";

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

/**
 * Attach values to the run's own metadata, from the step whose callback is
 * running.
 *
 * It only queues the update on the step's own result, so it adds no request,
 * and a step that's already memoized never runs its callback again, so nothing
 * is sent twice on replay. It must never fail the step, so anything that goes
 * wrong is a warning.
 */
export const tagRun = async (
  run: CiRunScope,
  values: Record<string, unknown> | undefined,
): Promise<void> => {
  try {
    const execution = (await getAsyncCtx())?.execution;
    const stepId = execution?.executingStep?.id;

    if (!execution || !stepId || !values) {
      return;
    }

    execution.instance.addMetadata(
      stepId,
      metadataKind,
      "run",
      "merge",
      values,
    );
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

/** Keep an outcome compact: long strings are cut and long lists trimmed. */
const compact = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") {
    return truncateLabel(value, maxOutcomeString);
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

/**
 * The step options for one of CI's steps: its ID, name and origin, and its
 * `userland.inngest-ci` metadata. The SDK attaches the metadata when the step
 * ends, so the step's body never mentions it, a replayed step sends it once,
 * and a step that throws still says what it set out to do, with the error's
 * first line as its outcome.
 *
 * Works for anything that takes step options, such as `step.run`.
 */
export const ciStepOptions = <T>(spec: StepSpec<T>): StepOptions => {
  const { outcome } = spec;

  return {
    id: spec.id,
    name: spec.name,
    ...(spec.yours ? {} : originOption(ciOrigin)),
    metadata: {
      kind: metadataKind,
      values: (result: { data?: unknown; error?: unknown }) => {
        const settled =
          result.error === undefined
            ? typeof outcome === "function"
              ? outcome(result.data as T)
              : outcome
            : {
                ...(typeof outcome === "function" ? {} : outcome),
                error: errorMessage(result.error).split("\n")[0] ?? "",
              };

        return {
          ...spec.tag,
          intent: truncateLabel(spec.intent, maxOutcomeString),
          outcome: compact(settled ?? {}),
        };
      },
    },
  };
};

/**
 * Run `fn` as one of CI's own steps, with its intent and outcome on the step's
 * `userland.inngest-ci` metadata. The spec comes from the `steps` catalog.
 */
export const ciRun = <T>(
  run: Pick<CiRunScope, "step">,
  spec: StepSpec<T>,
  fn: () => T | Promise<T>,
): Promise<T> => {
  return run.step.run(ciStepOptions(spec), fn) as Promise<T>;
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
  return ciRun(run, steps.recordRunDetails(id), async () => {
    await tagRun(run, runValues());

    return Date.now();
  });
};
