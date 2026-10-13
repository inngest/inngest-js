/**
 * `image`: the base images a job can start from, such as a sandbox you
 * captured under a name. Only the value and its validation live here; the
 * run looks the snapshot up in `machine/from.ts`.
 *
 * @module
 */

import { CiUsageError } from "./errors.ts";

/**
 * A machine image for a job to start from, made by `image.snapshot()`.
 */
export interface BaseImage {
  readonly kind: "inngest/ci.image";
  readonly source: "snapshot";
  /** The name the snapshot was captured under. */
  readonly name: string;
}

/** Whether a value is a {@link BaseImage}. */
export const isBaseImage = (value: unknown): value is BaseImage => {
  return (value as BaseImage | undefined)?.kind === "inngest/ci.image";
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
};
