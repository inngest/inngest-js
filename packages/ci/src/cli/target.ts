/**
 * Working out what to run: matching the target against the app's manifest, and
 * building the event that starts it, from the same fixtures a pull request
 * uses.
 *
 * @module
 */

import { fixtures } from "../github/fixtures.ts";
import type { PullRequestAction } from "../github/triggers.ts";
import type { LocalManifest, RunJobEventData } from "../local/protocol.ts";
import { localTargetKey, runJobEvent } from "../local/protocol.ts";
import { SetupError } from "./setupError.ts";

export type AxisValue = string | number | boolean;

/** One combination of a matrix's axes. */
export type Combo = Record<string, AxisValue>;

/** What can run: a pipeline, or a job (which may be a matrix). */
export type Target =
  | { kind: "pipeline"; id: string; events: string[] }
  | {
      kind: "job";
      id: string;

      /** Whether the job's handler declares a parameter. */
      takesInput: boolean;

      /** Set for a matrix: the combinations it really runs. */
      combos?: Combo[];
    };

export interface LocalEvent {
  name: string;
  data: Record<string, unknown>;
}

/** Everything the manifest defines that can run: pipelines, jobs, matrices. */
export const targetsOf = (manifest: LocalManifest): Target[] => {
  return [
    ...manifest.pipelines.map((pipeline): Target => {
      return {
        kind: "pipeline",
        id: pipeline.id,
        // Crons can't run locally.
        events: pipeline.triggers.flatMap((trigger) => {
          return "event" in trigger ? [trigger.event] : [];
        }),
      };
    }),
    ...manifest.jobs.map((job): Target => {
      return { kind: "job", id: job.id, takesInput: job.takesInput };
    }),
    ...manifest.matrices.map((matrix): Target => {
      return {
        kind: "job",
        id: matrix.id,
        takesInput: false,
        combos: matrix.combos,
      };
    }),
  ];
};

/** What can be run, one per line, for an error to list. */
export const listTargets = (targets: Target[]): string => {
  return targets
    .map((target) => {
      return `${target.kind} ${target.id}`;
    })
    .join("\n");
};

/** Find what the user named. A name that is both a pipeline and a job is an error. */
export const resolveTarget = (targets: Target[], name: string): Target => {
  const matches = targets.filter((target) => {
    return target.id === name;
  });

  if (matches.length > 1) {
    throw new SetupError(`"${name}" is both a pipeline and a job.`, {
      fix: "Rename one of them.",
    });
  }

  const [target] = matches;

  if (!target) {
    throw new SetupError(`Nothing named "${name}" to run.`, {
      fix: listTargets(targets),
    });
  }

  return target;
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

/** A pull request fixture's data: the repository context every run needs. */
const repoData = async (cwd: string): Promise<Record<string, unknown>> => {
  return (await fixtures.pullRequest({ cwd })).data;
};

/**
 * The event that triggers a pipeline: a fixture for a GitHub event, or the
 * `data` for a manual one. A manual event also carries the repository, so
 * `checkout()` has the working tree to upload. Other pipelines on the same
 * trigger also receive it, so it names the one to run, and the others skip it.
 */
export const buildPipelineEvent = async (opts: {
  pipelineId: string;
  trigger: string;
  data?: Record<string, unknown>;
  cwd: string;
}): Promise<LocalEvent> => {
  const { trigger, cwd } = opts;
  const data = opts.data ?? {};
  let event: LocalEvent;

  if (trigger.startsWith("ci/manual.")) {
    const { repository, local } = await repoData(cwd);

    event = { name: trigger, data: { repository, local, ...data } };
  } else if (trigger.startsWith("github/pull_request.")) {
    event = await fixtures.pullRequest({
      cwd,
      action: trigger.slice("github/pull_request.".length) as PullRequestAction,
    });
  } else if (trigger === "github/push") {
    event = await fixtures.push({ cwd });
  } else if (trigger === "github/issue_comment.created") {
    if (typeof data.body !== "string") {
      throw new SetupError("A comment trigger needs the comment's text.", {
        fix: `Pass it with --data '{"body": "/your command"}'.`,
      });
    }

    event = await fixtures.comment({ cwd, body: data.body });
  } else {
    throw new SetupError(`There is no local fixture for ${trigger}.`);
  }

  return {
    ...event,
    data: { ...event.data, [localTargetKey]: opts.pipelineId },
  };
};

/** The event that runs one job, or the given combinations of a matrix. */
export const buildJobEvent = async (opts: {
  target: Extract<Target, { kind: "job" }>;
  input?: unknown;

  /** Left out, every combination of a matrix runs. */
  combos?: Combo[];
  cwd: string;
}): Promise<LocalEvent> => {
  const data: RunJobEventData = {
    ...(await repoData(opts.cwd)),
    job: opts.target.id,
  };

  if (opts.input !== undefined) {
    data.input = opts.input;
  }

  if (opts.combos) {
    data.combos = opts.combos;
  }

  return { name: runJobEvent, data };
};

/** A combination as a job names it, like `node:22, os:linux`. */
export const describeCombo = (combo: Combo): string => {
  return Object.entries(combo)
    .map(([axis, value]) => {
      return `${axis}:${value}`;
    })
    .join(", ");
};

/**
 * The combinations `--<axis> <value>` flags pick: `undefined` for none, which
 * runs every combination. An axis given several times takes all its values,
 * and an axis left out takes any. Values are compared as text, so `--node 22`
 * finds the number `22`.
 */
export const selectCombos = (
  target: Extract<Target, { kind: "job" }>,
  flags: Record<string, string[]>,
): Combo[] | undefined => {
  const given = Object.keys(flags);

  if (given.length === 0) {
    return undefined;
  }

  const { combos } = target;

  if (!combos) {
    throw new SetupError(
      `This job isn't a matrix, so --${given[0]} doesn't apply.`,
    );
  }

  const axes = new Set(
    combos.flatMap((combo) => {
      return Object.keys(combo);
    }),
  );

  for (const axis of given) {
    if (!axes.has(axis)) {
      throw new SetupError(`Unknown option --${axis}.`, {
        fix: `Axes: ${[...axes].join(", ")}`,
      });
    }
  }

  const picked = combos.filter((combo) => {
    return given.every((axis) => {
      return flags[axis]?.includes(String(combo[axis]));
    });
  });

  if (picked.length === 0) {
    throw new SetupError("No combination of the matrix has those values.", {
      fix: `Combinations: ${combos.map(describeCombo).join("; ")}`,
    });
  }

  return picked;
};
