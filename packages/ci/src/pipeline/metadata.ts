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
import type { CheckConclusion, CiTrigger } from "../types.ts";
import { version } from "../version.ts";
import type { CiRunScope } from "./scope.ts";
import { apiNames } from "./scope.ts";

/**
 * The metadata kind everything here is attached under. It moves to
 * `inngest.ci` once the backend allowlists that kind (inngest/inngest branch
 * `jack/allow-inngest-ci-metadata`).
 */
export const metadataKind = "userland.inngest-ci";

/** What a step is for, attached to the step that does it. */
export interface StepTag {
  kind: "job" | "check" | "cache";
  /** The job's path. Left out for the pipeline's own check. */
  job?: string;
}

/**
 * The kinds of trigger a pipeline has: `github.pull_request` for
 * `github/pull_request.opened`, `cron`, `manual`, or the event name itself.
 */
export const triggerKinds = (triggers: CiTrigger[]): string[] => {
  const kinds = triggers.map((trigger) => {
    const { event, cron } = trigger as { event?: string; cron?: string };

    if (cron !== undefined) {
      return "cron";
    }

    if (event?.startsWith("ci/manual.")) {
      return "manual";
    }

    if (event?.startsWith("github/")) {
      return `github.${event.slice("github/".length).split(".")[0]}`;
    }

    return event ?? "unknown";
  });

  return [...new Set(kinds)];
};

/**
 * What's known when the run starts: which package and pipeline, what
 * triggered it, and which repository, ref and commit it's for.
 */
export const runStartMetadata = (run: CiRunScope): Record<string, unknown> => {
  const { repo } = run;
  const eventName = (run.event as { name?: string } | undefined)?.name;

  return {
    package: "@inngest/ci",
    version,
    pipeline: run.pipelineId,
    triggers: run.triggerKinds,
    ...(eventName ? { event: eventName } : {}),
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
 * What's known when the run ends: how it concluded, how long it took, how its
 * jobs fared and which APIs it called.
 *
 * Reads the clock, so only call it from inside a step.
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
    ...(run.startedAt === undefined
      ? {}
      : { durationMs: Date.now() - run.startedAt }),
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
 * Attach metadata to the step whose callback is running: `runValues` to the
 * run, and `step` to the step itself.
 *
 * It only queues the update on the step's own result, so it adds no request,
 * and a step that's already memoized never runs its callback again, so nothing
 * is sent twice on replay. It must never fail the step, so anything that goes
 * wrong is a warning.
 */
export const tagStep = async (
  run: CiRunScope,
  step?: StepTag,
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

/**
 * A step of its own that only carries run metadata and returns the time, for
 * a pipeline whose check is off and so has no step to ride on.
 */
export const metadataStep = (
  run: CiRunScope,
  id: string,
  runValues: () => Record<string, unknown>,
): Promise<number> => {
  return run.step.run({ id, name: id }, async () => {
    await tagStep(run, undefined, runValues());

    return Date.now();
  });
};
