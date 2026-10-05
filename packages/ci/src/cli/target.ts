/**
 * Working out what to run: matching the target against the app's manifest, and
 * building the event that starts it, from the same fixtures a pull request
 * uses.
 *
 * @module
 */

import { fixtures } from "../github/fixtures.ts";
import type { PullRequestAction } from "../github/triggers.ts";
import {
  type LocalManifest,
  type RunJobEventData,
  runJobEvent,
} from "../local/protocol.ts";
import { git } from "../util.ts";
import { SetupError } from "./setupError.ts";

type AxisValue = string | number | boolean;

export type Target =
  | {
      kind: "pipeline";
      id: string;
      triggers: LocalManifest["pipelines"][number]["triggers"];
    }
  | { kind: "job"; id: string; axes?: Record<string, AxisValue[]> };

export interface LocalEvent {
  name: string;
  data: Record<string, unknown>;
}

/** What the working tree is, for the header. */
export interface LocalRepo {
  fullName: string;
  ref: string;
  sha: string;
  dirty: boolean;
  /** The pull request fixture's data, which `RunJobEventData` carries. */
  fixtureData: Record<string, unknown>;
}

const list = (items: string[]): string => {
  return items.length ? items.join(", ") : "none";
};

/**
 * Find what the user named in the manifest. A bare name must be unambiguous;
 * `--pipeline` and `--job` say which when it isn't.
 */
export const resolveTarget = (
  manifest: LocalManifest,
  args: { name?: string; pipeline?: string; job?: string },
): Target => {
  const name = args.pipeline ?? args.job ?? args.name;
  const pipeline = args.job
    ? undefined
    : manifest.pipelines.find((candidate) => {
        return candidate.id === name;
      });
  const matrix = args.pipeline
    ? undefined
    : manifest.matrices.find((candidate) => {
        return candidate.id === name;
      });
  const job = args.pipeline
    ? undefined
    : manifest.jobs.find((candidate) => {
        return candidate.id === name;
      });

  if (pipeline && (job || matrix)) {
    throw new SetupError(`"${name}" is both a pipeline and a job.`, {
      fix: `Use --pipeline ${name} or --job ${name}.`,
    });
  }

  if (pipeline) {
    return { kind: "pipeline", id: pipeline.id, triggers: pipeline.triggers };
  }

  if (matrix) {
    return { kind: "job", id: matrix.id, axes: matrix.axes };
  }

  if (job) {
    return { kind: "job", id: job.id };
  }

  throw new SetupError(`Nothing named "${name}" to run.`, {
    fix: `Pipelines: ${list(manifest.pipelines.map((p) => p.id))}\nJobs: ${list([...manifest.jobs, ...manifest.matrices].map((j) => j.id))}`,
  });
};

const parseJson = (flag: string, value: string): Record<string, unknown> => {
  try {
    return JSON.parse(value);
  } catch {
    throw new SetupError(`--${flag} is not valid JSON.`);
  }
};

/**
 * The trigger to run a pipeline with. A pipeline with several needs `--event`,
 * except interactively, where the first is used until picking is built.
 */
export const pickTrigger = (
  triggers: Extract<Target, { kind: "pipeline" }>["triggers"],
  opts: { event?: string; interactive: boolean },
): string => {
  const events = triggers.flatMap((trigger) => {
    return "event" in trigger ? [trigger.event] : [];
  });

  if (events.length === 0) {
    throw new SetupError("Cron triggers can't be run locally yet.");
  }

  if (opts.event) {
    const match = events.find((event) => {
      return event === opts.event || event === `github/${opts.event}`;
    });

    if (!match) {
      throw new SetupError(`This pipeline has no "${opts.event}" trigger.`, {
        fix: `Triggers: ${events.join(", ")}`,
      });
    }

    return match;
  }

  if (events.length > 1 && !opts.interactive) {
    throw new SetupError("This pipeline has several triggers.", {
      fix: `Pick one with --event: ${events.join(", ")}`,
    });
  }

  return events[0] as string;
};

/**
 * The event that triggers a pipeline: a fixture for a GitHub event, or the
 * `--data` for a manual one. A manual event also carries the repository, so
 * `checkout()` has the working tree to upload.
 */
export const buildPipelineEvent = async (opts: {
  trigger: string;
  data?: string;
  cwd: string;
}): Promise<LocalEvent> => {
  const { trigger, cwd } = opts;
  const data = opts.data ? parseJson("data", opts.data) : {};

  if (trigger.startsWith("ci/manual.")) {
    const { fixtureData } = await describeRepo(cwd);

    return {
      name: trigger,
      data: {
        repository: fixtureData.repository,
        local: fixtureData.local,
        ...data,
      },
    };
  }

  if (trigger.startsWith("github/pull_request.")) {
    return fixtures.pullRequest({
      cwd,
      action: trigger.slice("github/pull_request.".length) as PullRequestAction,
    });
  }

  if (trigger === "github/push") {
    return fixtures.push({ cwd });
  }

  if (trigger === "github/issue_comment.created") {
    if (typeof data.body !== "string") {
      throw new SetupError("A comment trigger needs the comment's text.", {
        fix: `Pass it with --data '{"body": "/your command"}'.`,
      });
    }

    return fixtures.comment({ cwd, body: data.body });
  }

  throw new SetupError(`There is no local fixture for ${trigger}.`);
};

/** The working tree's repository, for the header and for job events. */
export const describeRepo = async (cwd: string): Promise<LocalRepo> => {
  const { data } = await fixtures.pullRequest({ cwd });
  const pullRequest = data.pull_request as {
    head: { ref: string; sha: string };
  };
  const status = await git(cwd, ["status", "--porcelain"]);

  return {
    fullName: (data.repository as { full_name: string }).full_name,
    ref: pullRequest.head.ref,
    sha: pullRequest.head.sha.slice(0, 7),
    dirty: status.trim() !== "",
    fixtureData: data,
  };
};

/**
 * The matrix combination from `--<axis> <value>` flags: `undefined` for none,
 * which runs every combination. Values are matched against the axis's own, so
 * `--node 22` finds the number `22`.
 */
export const parseCombo = (
  axes: Record<string, AxisValue[]> | undefined,
  flags: Record<string, string>,
): Record<string, AxisValue> | undefined => {
  const given = Object.keys(flags);

  if (given.length === 0) {
    return undefined;
  }

  if (!axes) {
    throw new SetupError(
      `This job isn't a matrix, so --${given[0]} doesn't apply.`,
    );
  }

  const unknown = given.find((axis) => {
    return !(axis in axes);
  });

  if (unknown) {
    throw new SetupError(`Unknown option --${unknown}.`, {
      fix: `Axes: ${list(Object.keys(axes))}`,
    });
  }

  const combo: Record<string, AxisValue> = {};

  for (const [axis, values] of Object.entries(axes)) {
    const flag = flags[axis];

    if (flag === undefined) {
      throw new SetupError(`Missing --${axis}.`, {
        fix: `Give every axis, or none to run every combination. Axes: ${list(Object.keys(axes))}`,
      });
    }

    const value = values.find((candidate) => {
      return String(candidate) === flag;
    });

    if (value === undefined) {
      throw new SetupError(`"${flag}" isn't a value of ${axis}.`, {
        fix: `Values: ${values.join(", ")}`,
      });
    }

    combo[axis] = value;
  }

  return combo;
};

/** The event that runs one job, or one combination of a matrix. */
export const buildJobEvent = (opts: {
  target: Extract<Target, { kind: "job" }>;
  repo: LocalRepo;
  input?: string;
  combo: Record<string, string>;
}): LocalEvent => {
  const data: RunJobEventData = {
    ...opts.repo.fixtureData,
    job: opts.target.id,
  };

  if (opts.input) {
    data.input = parseJson("input", opts.input);
  }

  const combo = parseCombo(opts.target.axes, opts.combo);

  if (combo) {
    data.combo = combo;
  }

  return { name: runJobEvent, data };
};
