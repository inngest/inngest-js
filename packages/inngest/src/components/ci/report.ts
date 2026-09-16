import { CiNotSupportedError } from "./errors.ts";
import { getJobScope, nextStepId, requireRunScope } from "./scope.ts";
import type { CheckAnnotation } from "./types.ts";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Add to the current job's check. Outside a job, these target the pipeline
 * check.
 */
export const report = {
  /**
   * Add a section to the check's summary.
   */
  summary: async (markdown: string): Promise<void> => {
    const run = requireRunScope("report.summary");
    const job = getJobScope();

    const id = nextStepId(run, job?.path, "report:summary");

    await run.step.run({ id, name: "report:summary" }, () => ({
      length: markdown.length,
    }));

    if (job) {
      job.summaries.push(markdown);
      return;
    }

    run.pipelineSummaries.push(markdown);
  },

  /**
   * Queue annotations for the check's next update. They're flushed when the
   * job ends.
   */
  annotate: async (annotations: CheckAnnotation[]): Promise<void> => {
    const run = requireRunScope("report.annotate");
    const job = getJobScope();

    const valid = annotations.filter(
      (annotation) => annotation.path && annotation.message,
    );

    const id = nextStepId(run, job?.path, "report:annotate");
    await run.step.run({ id, name: "report:annotate" }, () => ({
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
