import { CiNotSupportedError } from "./errors.ts";
import { getJobScope, nextStepId, requireRunScope } from "./scope.ts";
import type { CheckAnnotation } from "./types.ts";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Add to the current job's check. Outside a job, these target the pipeline
 * check.
 *
 * ```ts
 * await report.summary(`Coverage: **${coverage}%**`);
 * await report.annotate([
 *   { path: "src/queue.ts", line: 42, message: "Flaky retry here" },
 * ]);
 * ```
 */
export const report = {
  /**
   * Add a section to the check's summary, as markdown.
   *
   * Summaries are truncated at GitHub's 65,000 character limit, with a note
   * pointing at the trace.
   *
   * @param markdown - What to add. Called several times, sections stack.
   * @throws {CiUsageError} When called outside a pipeline run.
   */
  summary: async (markdown: string): Promise<void> => {
    const run = requireRunScope("report.summary");
    const job = getJobScope();

    const id = nextStepId(run, job?.path, "report:summary");

    await run.step.run({ id, name: id }, () => ({
      length: markdown.length,
    }));

    if (job) {
      job.summaries.push(markdown);
      return;
    }

    run.pipelineSummaries.push(markdown);
  },

  /**
   * Put annotations on the diff, and on the check.
   *
   * They're queued and flushed when the job ends, in batches of 50, which is
   * GitHub's limit per request.
   *
   * ```ts
   * await report.annotate([
   *   { path: "src/a.ts", line: 4, message: "unused export" },
   *   {
   *     path: "src/b.ts",
   *     start_line: 10,
   *     end_line: 14,
   *     annotation_level: "warning",
   *     message: "slow query",
   *   },
   * ]);
   * ```
   *
   * @param annotations - Anything without a `path` and a `message` is
   * dropped, since GitHub would reject the whole batch.
   * @throws {CiUsageError} When called outside a pipeline run.
   */
  annotate: async (annotations: CheckAnnotation[]): Promise<void> => {
    const run = requireRunScope("report.annotate");
    const job = getJobScope();

    const valid = annotations.filter(
      (annotation) => annotation.path && annotation.message,
    );

    const id = nextStepId(run, job?.path, "report:annotate");
    await run.step.run({ id, name: id }, () => ({
      count: valid.length,
    }));

    if (job) {
      job.annotations.push(...valid);
      return;
    }

    run.pipelineAnnotations.push(...valid);
  },

  /**
   * @deprecated Not yet supported by Inngest Sandboxes: the JUnit parser isn't
   * built. Throws `CiNotSupportedError`.
   */
  junit: async (_path: string): Promise<void> => {
    throw new CiNotSupportedError(
      "report.junit",
      "`report.junit()` isn't implemented in this prototype. Parse the report yourself and call `report.annotate()`.",
    );
  },
};
