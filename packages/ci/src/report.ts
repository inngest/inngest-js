/**
 * The `report` API: adding annotations and summaries to the current check.
 *
 * @module
 */

import { readReportFile } from "./machine/reports.ts";
import { ciRun } from "./pipeline/metadata.ts";
import { steps } from "./pipeline/names.ts";
import {
  countApi,
  getJobScope,
  nextStepId,
  requireJobScope,
  requireRunScope,
} from "./pipeline/scope.ts";
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
   * Called several times, sections stack. Summaries are truncated to 65,000
   * bytes, under GitHub's 65535 byte limit, with a note pointing at the trace.
   *
   * @throws {CiUsageError} When called outside a pipeline run.
   */
  summary: async (/** What to add. */ markdown: string): Promise<void> => {
    const run = requireRunScope("report.summary");

    countApi("report");
    const job = getJobScope();

    const id = nextStepId(run, job?.path, "report:summary");

    await ciRun(run, steps.addSummary(id), () => {
      return {
        length: markdown.length,
      };
    });

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
   * Anything without a `path` and a `message` is dropped, since GitHub would
   * reject the whole batch.
   *
   * @throws {CiUsageError} When called outside a pipeline run.
   */
  annotate: async (annotations: CheckAnnotation[]): Promise<void> => {
    const run = requireRunScope("report.annotate");

    countApi("report");
    const job = getJobScope();

    const valid = annotations.filter((annotation) => {
      return annotation.path && annotation.message;
    });

    const id = nextStepId(run, job?.path, "report:annotate");

    await ciRun(run, steps.addAnnotations(id), () => {
      return {
        count: valid.length,
      };
    });

    if (job) {
      job.annotations.push(...valid);

      return;
    }

    run.pipelineAnnotations.push(...valid);
  },

  /**
   * Annotate the diff from a report file a tool wrote on the job's machine:
   * failed tests from vitest or jest (`--reporter=json`, `--json`), lint from
   * eslint (`-f json`) or biome (`--reporter=json`), or type errors from the
   * text of `tsc --pretty false`.
   *
   * A command that asks for its report as a direct call, such as
   * `vitest run --reporter=json --outputFile=out.json`, is read without this.
   * Use it when a script runs the tool.
   *
   * ```ts
   * await $`pnpm test:ci`.nothrow();
   * await report.results("vitest", "test-results.json");
   * ```
   *
   * A file that is not in that format adds nothing.
   *
   * @throws {CiUsageError} When called outside a job.
   */
  results: async (
    format: "vitest" | "jest" | "eslint" | "biome" | "tsc",
    /** Where the report is, relative to the job's working directory. */
    path: string,
  ): Promise<void> => {
    const job = requireJobScope("report.results");

    countApi("report");

    await readReportFile(job, format, path);
  },
};
