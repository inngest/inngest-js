/**
 * The hooks a run calls as it goes: what a job is doing, which command is
 * running, how a job ended. They are for a tool that watches a run, such as a
 * local reporter, and are not part of the public API. The default hooks do
 * nothing, and a hook never blocks or fails a run.
 *
 * @module
 */

import type { CheckSink } from "../github/checks.ts";
import type { CommandResult } from "../types.ts";
import type { CiJobScope, CiRunScope } from "./scope.ts";

/** Where a job or pipeline is up to. */
export type LocalStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "skipped"
  | "cached";

/** A command attempt, as it's named to a hook. */
export interface CommandAttempt {
  /** The command's step ID. */
  id: string;
  name: string;
  attempt: number;
}

export interface CiHooks {
  /**
   * Wrap the sink checks go to, so the pipeline's and each job's start and
   * finish can be watched too. Called once, when the client is created.
   */
  wrapSink(sink: CheckSink): CheckSink;
  /** What a job is doing at a slow point that isn't a command. */
  activity(run: CiRunScope, jobId: string, text: string): void;
  commandStarted(scope: CiJobScope, command: CommandAttempt): void;
  commandFinished(
    scope: CiJobScope,
    command: CommandAttempt,
    result: CommandResult,
  ): void;
  /** A job started from another job's machine. */
  jobFrom(scope: CiJobScope, parentId: string): void;
  /** Where a job's own run is, when another run builds it. */
  jobRunUrl(run: CiRunScope, jobId: string, url: string): void;
  /** How a job built in a run of its own ended, as the run that needed it sees. */
  jobEnded(
    run: CiRunScope,
    jobId: string,
    status: LocalStatus,
    title?: string,
  ): void;
  /** What the run wants to say once it's over, like a cache that's missing. */
  warnings(run: CiRunScope): void;
}

/** The hooks a client has until something replaces them: all do nothing. */
export const noopHooks: CiHooks = {
  wrapSink: (sink) => {
    return sink;
  },
  activity: () => {},
  commandStarted: () => {},
  commandFinished: () => {},
  jobFrom: () => {},
  jobRunUrl: () => {},
  jobEnded: () => {},
  warnings: () => {},
};
