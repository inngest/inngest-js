/**
 * `image`: bases a job can start from besides another job of its own app. An
 * image says how to get the build to start from, and the run takes it from
 * there, so a new kind of image is a new entry in `image` and nothing else.
 *
 * @module
 */

import { CiUsageError } from "./errors.ts";
import { requestAppJob } from "./pipeline/appJob.ts";
import type { CacheBuildResult } from "./pipeline/cacheBuild.ts";
import type { CiRunScope } from "./pipeline/scope.ts";
import { hash, stableStringify } from "./util.ts";

/** A base for a job to start from, made by one of the functions of `image`. */
export interface Image {
  readonly kind: "inngest/ci.image";
  /** What the image is called in notes and step IDs, and what keys of jobs on it know it by. */
  readonly name: string;
  /** Get the build to start from, once per pipeline run however many jobs ask. */
  readonly resolve: (run: CiRunScope) => Promise<CacheBuildResult>;
}

/** Whether a value is an {@link Image}. */
export const isImage = (value: unknown): value is Image => {
  return (value as Image | undefined)?.kind === "inngest/ci.image";
};

export const image = {
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
   * ci.job({ id: "web", from: image.job("platform/build", "web") }, async () => {
   *   await $`pnpm test`;
   * });
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
  ): Image => {
    const [, app, job] = /^([^/\s]+)\/(\S+)$/.exec(ref) ?? [];

    if (!app || !job) {
      throw new CiUsageError(
        `\`image.job("${ref}")\`: name another app's job as \`app/job\`, like \`image.job("platform/node-base")\`.`,
      );
    }

    const name =
      input === undefined ? ref : `${ref} #${hash(stableStringify(input), 8)}`;

    return Object.freeze({
      kind: "inngest/ci.image",
      name,
      resolve: (run: CiRunScope) => {
        return requestAppJob(run, { name, app, job, input });
      },
    });
  },
};
