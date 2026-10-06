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

export type AxisValue = string | number | boolean;

/** One combination of a matrix's axes. */
export type Combo = Record<string, AxisValue>;

export type Target =
  | {
      kind: "pipeline";
      id: string;
      triggers: LocalManifest["pipelines"][number]["triggers"];
      /** Only a matrix has axes; this lets any target be asked. */
      axes?: undefined;
    }
  | {
      kind: "job";
      id: string;
      /** Whether the job's handler declares a parameter. */
      takesInput: boolean;
      /** Set for a matrix. */
      axes?: Record<string, AxisValue[]>;
    };

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

/** Everything the manifest defines that can run: pipelines, jobs, then matrices. */
export const targetsOf = (manifest: LocalManifest): Target[] => {
  return [
    ...manifest.pipelines.map((pipeline): Target => {
      return { kind: "pipeline", id: pipeline.id, triggers: pipeline.triggers };
    }),
    ...manifest.jobs.map((job): Target => {
      return { kind: "job", id: job.id, takesInput: job.takesInput };
    }),
    ...manifest.matrices.map((matrix): Target => {
      return {
        kind: "job",
        id: matrix.id,
        takesInput: false,
        axes: matrix.axes,
      };
    }),
  ];
};

/** What can be run, for an error to list. */
export const listTargets = (manifest: LocalManifest): string => {
  return [
    `Pipelines: ${list(manifest.pipelines.map((p) => p.id))}`,
    `Jobs: ${list([...manifest.jobs, ...manifest.matrices].map((j) => j.id))}`,
  ].join("\n");
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
  const matches = targetsOf(manifest).filter((target) => {
    if (target.id !== name) {
      return false;
    }

    if (args.pipeline) {
      return target.kind === "pipeline";
    }

    return args.job ? target.kind === "job" : true;
  });
  const [target] = matches;

  if (matches.length > 1) {
    throw new SetupError(`"${name}" is both a pipeline and a job.`, {
      fix: `Use --pipeline ${name} or --job ${name}.`,
    });
  }

  if (!target) {
    throw new SetupError(`Nothing named "${name}" to run.`, {
      fix: listTargets(manifest),
    });
  }

  return target;
};

/** The events a pipeline can be triggered with. Crons can't run locally. */
export const triggerEvents = (
  triggers: Extract<Target, { kind: "pipeline" }>["triggers"],
): string[] => {
  const events = triggers.flatMap((trigger) => {
    return "event" in trigger ? [trigger.event] : [];
  });

  if (events.length === 0) {
    throw new SetupError("Cron triggers can't be run locally yet.");
  }

  return events;
};

/** The trigger `--event` names. `github/` can be left off. */
export const matchTrigger = (events: string[], name: string): string => {
  const match = events.find((event) => {
    return event === name || event === `github/${name}`;
  });

  if (!match) {
    throw new SetupError(`This pipeline has no "${name}" trigger.`, {
      fix: `Triggers: ${events.join(", ")}`,
    });
  }

  return match;
};

/**
 * The event that triggers a pipeline: a fixture for a GitHub event, or the
 * `data` for a manual one. A manual event also carries the repository, so
 * `checkout()` has the working tree to upload.
 */
export const buildPipelineEvent = async (opts: {
  trigger: string;
  data?: Record<string, unknown>;
  cwd: string;
}): Promise<LocalEvent> => {
  const { trigger, cwd } = opts;
  const data = opts.data ?? {};

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
): Combo | undefined => {
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

  const combo: Combo = {};

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
  input?: unknown;
  /** A matrix's combination. Left out, every combination runs. */
  combo?: Combo;
}): LocalEvent => {
  const data: RunJobEventData = {
    ...opts.repo.fixtureData,
    job: opts.target.id,
  };

  if (opts.input !== undefined) {
    data.input = opts.input;
  }

  if (opts.combo && Object.keys(opts.combo).length > 0) {
    data.combo = opts.combo;
  }

  return { name: runJobEvent, data };
};

/** Every combination of a matrix's axes, in declaration order. */
export const combinations = (axes: Record<string, AxisValue[]>): Combo[] => {
  return Object.entries(axes).reduce<Combo[]>(
    (combos, [axis, values]) => {
      return combos.flatMap((combo) => {
        return values.map((value) => {
          return { ...combo, [axis]: value };
        });
      });
    },
    [{}],
  );
};

/** A combination as a job names it, like `node:22, os:linux`. */
export const describeCombo = (combo: Combo): string => {
  return Object.entries(combo)
    .map(([axis, value]) => {
      return `${axis}:${value}`;
    })
    .join(", ");
};
