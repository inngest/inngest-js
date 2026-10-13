/**
 * `image`: the base images a job can start from, such as a sandbox you
 * captured under a name, or a job another app defines. Only the values and
 * their validation live here; the run resolves them in `machine/from.ts`.
 *
 * @module
 */

import { CiUsageError } from "./errors.ts";
import { hash, stableStringify } from "./util.ts";

/** A sandbox you captured, made by `image.snapshot()`. */
interface SnapshotImage {
  readonly kind: "inngest/ci.image";
  readonly source: "snapshot";
  /** The name the snapshot was captured under. */
  readonly name: string;
}

/** Another app's job, made by `image.job()`. */
export interface JobImage {
  readonly kind: "inngest/ci.image";
  readonly source: "job";
  /** `app/job`, with a hash of the input when the job takes one. */
  readonly name: string;
  readonly app: string;
  readonly job: string;
  readonly input?: unknown;
}

/**
 * A machine image for a job to start from, made by `image.snapshot()` or
 * `image.job()`.
 */
export type BaseImage = SnapshotImage | JobImage;

/** Whether a value is a {@link BaseImage}. */
export const isBaseImage = (value: unknown): value is BaseImage => {
  return (value as BaseImage | undefined)?.kind === "inngest/ci.image";
};

/**
 * What tells one image from another in a run, in step IDs and in names: the
 * source and the name, so a snapshot and a job called alike never meet.
 */
export const imageKey = (image: BaseImage): string => {
  return `${image.source}:${image.name}`;
};

/** What a snapshot name must not be, and what to tell whoever chose it. */
const nameRules: [broken: (name: string) => boolean, problem: string][] = [
  [
    (name) => {
      return /\s/.test(name);
    },
    "a snapshot name can't contain whitespace.",
  ],
  [
    (name) => {
      return name.startsWith("ci/");
    },
    "names starting with `ci/` belong to CI's own snapshots. Capture yours under another name.",
  ],
];

export const image = {
  /**
   * Start a job from a sandbox you captured, so its dependencies are already
   * installed and nothing has to be set up first.
   *
   * Capture one with the Sandboxes API, then name it here. The job starts
   * from the newest ready snapshot with exactly that name.
   *
   * ```ts
   * // Once, anywhere you have a sandbox:
   * await sandbox.snapshot({ name: "agent-deps" });
   *
   * // Every job starts from it by default…
   * const ci = createCi(inngest, { from: image.snapshot("agent-deps") });
   *
   * // …unless it says otherwise.
   * ci.job({ id: "test", from: image.snapshot("agent-base") }, async () => {
   *   await $`pnpm test`;
   * });
   * ```
   *
   * @throws {CiUsageError} When the name is empty, has whitespace, or starts
   * with `ci/`, which is where CI keeps its own snapshots.
   */
  snapshot: (
    /** The name the snapshot was captured under. */
    name: string,
  ): BaseImage => {
    if (typeof name !== "string" || name.length === 0) {
      throw new CiUsageError(
        "`image.snapshot()` needs the name of a snapshot.",
      );
    }

    for (const [broken, problem] of nameRules) {
      if (broken(name)) {
        throw new CiUsageError(`\`image.snapshot("${name}")\`: ${problem}`);
      }
    }

    return Object.freeze({
      kind: "inngest/ci.image",
      source: "snapshot",
      name,
    });
  },

  /**
   * Start a job from a job another app defines, such as a shared base image a
   * platform team owns. The other app builds it if it's missing, from the
   * commit it was deployed from, and every app that starts from it shares the
   * one build.
   *
   * ```ts
   * ci.job({ id: "test", from: image.job("platform/node-base") }, async () => {
   *   await $`pnpm test`;
   * });
   *
   * // A job that takes input is given it here.
   * ci.job({ id: "web", from: image.job("platform/build", { target: "web" }) }, …);
   * ```
   *
   * Both apps must be in the same Inngest environment and run `@inngest/ci`.
   *
   * @throws {CiUsageError} When the reference isn't `app/job`.
   */
  job: (
    /** The app's ID and the job's ID, as `app/job`. */
    ref: string,
    /** The job's input, when it takes one. */
    input?: unknown,
  ): BaseImage => {
    const slash = typeof ref === "string" ? ref.indexOf("/") : -1;
    const app = slash > 0 ? ref.slice(0, slash) : "";
    const job = slash > 0 ? ref.slice(slash + 1) : "";

    if (!/^[A-Za-z0-9_.-]+$/.test(app) || !job || /\s/.test(job)) {
      throw new CiUsageError(
        `\`image.job("${ref}")\`: name another app's job as \`app/job\`, like \`image.job("platform/node-base")\`.`,
      );
    }

    const suffix =
      input === undefined ? "" : ` #${hash(stableStringify(input), 8)}`;

    return Object.freeze({
      kind: "inngest/ci.image",
      source: "job",
      name: `${app}/${job}${suffix}`,
      app,
      job,
      ...(input === undefined ? {} : { input }),
    });
  },
};
