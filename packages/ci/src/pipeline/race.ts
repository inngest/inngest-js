/**
 * Running a pipeline's handler in Inngest's race parallel mode. The executor
 * only re-invokes a function after a step ends if nothing else is pending or
 * the step is in race mode, so without it a background pause, or one slow job
 * among parallel ones, holds back every other job. Everything about enabling
 * the mode, and falling back when the runtime can't, lives here.
 *
 * @module
 */

import { getAsyncCtx } from "inngest/experimental";
import type { CiRunScope } from "./scope.ts";

/** The part of the SDK's `group` tools this file uses. */
interface ParallelTools {
  parallel?: <T>(
    options: { mode: "race" },
    callback: () => Promise<T>,
  ) => Promise<T>;
}

/**
 * Run `fn` with every step it creates in race mode. Where the runtime has no
 * AsyncLocalStorage the SDK can't set the mode, so `fn` runs without it and
 * the run gets a warning instead of failing.
 */
export const inRaceMode = async <T>(
  run: CiRunScope,
  // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
  ctx: any,
  fn: () => Promise<T>,
): Promise<T> => {
  const group = ctx.group as ParallelTools | undefined;

  let started = false;

  const body = async (): Promise<T> => {
    started = true;

    // The run's saved async context predates the mode, and job and GitHub
    // spans run inside it, so it's replaced with one that carries the mode.
    const current = await getAsyncCtx();

    if (current) {
      run.asyncCtx = current;
    }

    return fn();
  };

  try {
    if (typeof group?.parallel !== "function") {
      throw new Error("This SDK has no `group.parallel()`.");
    }

    return await group.parallel({ mode: "race" }, body);
  } catch (error) {
    if (started) {
      throw error;
    }

    run.warnings.push(
      "Parallel jobs and background pauses can block each other: race mode is unavailable here, so the run proceeds without it.",
    );

    return fn();
  }
};
