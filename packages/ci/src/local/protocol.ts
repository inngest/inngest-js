/**
 * The private contract between the `inngest-ci` CLI and the app it boots: the
 * env vars the CLI sets, the event that runs one job, and the messages the
 * app's `createCi` sends back. Both sides always come from the same installed
 * `@inngest/ci`, so nothing here is versioned or public.
 *
 * @module
 */

import type { LocalStatus } from "../pipeline/hooks.ts";
import type { JsonSchema } from "./jsonSchema.ts";

export type { LocalStatus };

/** Env vars the CLI sets on the app process. */
export const localEnv = {
  /** `"1"` when the app was started by `inngest-ci`. Read by `ci.local`. */
  local: "INNGEST_CI_LOCAL",
  /** Where the app sends {@link LocalMessage}s, as `http://127.0.0.1:<port>`. */
  reporterUrl: "INNGEST_CI_REPORTER_URL",
} as const;

/**
 * The event that starts the CLI-only function that runs one job. Not under
 * `inngest/`, which the Dev Server reserves.
 */
export const runJobEvent = "ci/run-job";

/** The ID of the CLI-only function that runs one job. */
export const runJobFunctionId = "ci-run-job";

/**
 * `data` of a {@link runJobEvent}: a pull request fixture's data (`repository`,
 * `pull_request`, `local`, ...), so the run derives its repository context the
 * way a pull request run does and `checkout()` uploads the working tree, plus
 * what to run.
 */
export interface RunJobEventData extends Record<string, unknown> {
  /** The job's ID, or the matrix's ID when `combo` is set. */
  job: string;
  /** The job's input, for jobs that take one. */
  input?: unknown;
  /**
   * The combinations of a matrix to run, when `job` names one. Left out, every
   * combination runs.
   */
  combos?: Record<string, string | number | boolean>[];
}

/** What the app defines, sent once its functions are served. */
export interface LocalManifest {
  pipelines: {
    id: string;
    /**
     * Trigger event names (`github/pull_request.opened`, `ci/manual.deploy`)
     * with their filter expression, and crons. A manual trigger carries the
     * JSON Schema of its data, when its schema can be written as one.
     */
    triggers: (
      | { event: string; if?: string; schema?: JsonSchema }
      | { cron: string }
    )[];
  }[];
  jobs: {
    id: string;
    /**
     * Whether the job's handler declares a parameter. Read from its arity,
     * so a handler that only uses `arguments` or a rest parameter reads as
     * taking none.
     */
    takesInput: boolean;
    /** The JSON Schema of the job's `input` schema, when it has one. */
    input?: JsonSchema;
  }[];
  matrices: {
    id: string;
    axes: Record<string, (string | number | boolean)[]>;
    /**
     * The combinations the matrix really runs: its axes' product with
     * `exclude` removed and `include` added.
     */
    combos: Record<string, string | number | boolean>[];
  }[];
}

/**
 * One message from the app to the CLI. Sent as JSON in a `POST` to
 * {@link localEnv.reporterUrl}. Sending is fire-and-forget and never throws
 * into the run. A message can arrive more than once (a step retried), so the
 * CLI treats the latest message per key as the truth.
 */
export type LocalMessage =
  | { kind: "manifest"; manifest: LocalManifest }
  | {
      kind: "run";
      runId: string;
      /** The event that started the run, which tells runs of one function apart. */
      eventId: string;
      /** The pipeline's ID, or {@link runJobFunctionId}. */
      pipelineId: string;
      status: LocalStatus;
      /** Why it ended, for a failed or skipped run. */
      reason?: string;
      url: string;
      at: number;
    }
  | {
      kind: "job";
      runId: string;
      /** The job's ID as it appears on its check, like `compat (node:22)`. */
      jobId: string;
      status: LocalStatus;
      /** The job it started `from`, if any. */
      parentId?: string;
      /** The check title, like `` `pnpm test` exited with 1 ``. */
      title?: string;
      /**
       * Where the job's own run is, for a job another run is building: the
       * CLI opens it on the job instead of the pipeline's run.
       */
      url?: string;
      at: number;
    }
  | {
      kind: "activity";
      runId: string;
      jobId: string;
      /** What the job is doing while no command runs, like `creating machine…`. */
      text: string;
      at: number;
    }
  | {
      kind: "warning";
      runId: string;
      /** A note about the run, like a job that isn't cached but could be. */
      text: string;
      at: number;
    }
  | {
      kind: "command";
      runId: string;
      jobId: string;
      /** Stable within the job: the command's step ID. */
      commandId: string;
      /** The command as shown in the trace, or its `.as()` name. */
      name: string;
      attempt: number;
      status: "running" | "passed" | "failed";
      exitCode?: number;
      durationMs?: number;
      /** The last lines of stdout and stderr, for a finished command. */
      outputTail?: string;
      at: number;
    };
