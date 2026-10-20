/**
 * Starting from a job another app defines, `image.job("app/job")`: the request
 * a pipeline sends that app's `ci/build`, and how that app answers it.
 *
 * The asking app hasn't got the other app's jobs, so it can't work out their
 * names and asks for the job itself. The owner builds what's missing, once for
 * every app that asks, and answers with the build to start from.
 *
 * @module
 */

import { NonRetriableError, referenceFunction } from "inngest";
import { deployedRepo } from "../github/deployRepo.ts";
import {
  buildOf,
  cycleMessage,
  withoutUnreusableCache,
} from "../machine/from.ts";
import { errorMessage } from "../util.ts";
import type { CacheBuildData, CacheBuildResult } from "./cacheBuild.ts";
import { cacheBuildFunctionId } from "./cacheBuild.ts";
import type { RegisteredJob } from "./job.ts";
import { adoptBuilt, buildParent, validateInput } from "./job.ts";
import { ciRun } from "./metadata.ts";
import { stepOptions, steps } from "./names.ts";
import type { CiRunScope } from "./scope.ts";
import { rootRunIdOf } from "./scope.ts";

/** The `app/job`s whose builds led to this run, outermost first. */
export const chainOf = (run: CiRunScope): string[] => {
  const { build } = run;

  return build
    ? [...(build.chain ?? []), `${run.ci.client.id}/${build.jobId}`]
    : [];
};

/**
 * Get the build of another app's job: one invoke of that app's `ci/build`,
 * which answers once it has found or built it.
 */
export const requestAppJob = async (
  run: CiRunScope,
  image: {
    /** What the image is called, with a hash of its input when it has one. */
    name: string;
    app: string;
    job: string;
    input?: unknown;
  },
): Promise<CacheBuildResult> => {
  const { name, app, job, input } = image;
  const chain = chainOf(run);

  // A build holds its job's one slot while it waits on what it asks for, so a
  // job asked for again down its own chain would wait on itself forever.
  if (chain.includes(`${app}/${job}`)) {
    throw new NonRetriableError(cycleMessage([...chain, `${app}/${job}`]));
  }

  const stepId = `image ${name}`;

  const data: CacheBuildData = {
    jobId: job,
    slot: `${run.runId}:${stepId}`,
    ...(input === undefined ? {} : { input }),
    ownKey: "",
    // One request per job and input at a time, so apps that ask together
    // share the one build.
    cacheKey: stepId,
    chain,
    askedByApp: true,
    rootRunId: rootRunIdOf(run),
    parent: buildParent(run, stepId),
  };

  let built: CacheBuildResult | null;

  try {
    built = (await run.step.invoke(
      stepOptions(steps.buildAppJob(stepId, name)),
      {
        function: referenceFunction({
          appId: app,
          functionId: cacheBuildFunctionId,
        }),
        data,
      },
    )) as CacheBuildResult | null;
  } catch (error) {
    throw new NonRetriableError(
      `\`${name}\` couldn't be built by \`${app}\`: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!built?.snapshotId) {
    throw new NonRetriableError(
      `\`${name}\` has no snapshot to start from: it ran no commands, or \`${app}\` couldn't take one.`,
    );
  }

  // A snapshot only this run needs is this run's to delete when it ends.
  adoptBuilt(run, built);

  return built;
};

/**
 * Answer another app's request for one of this app's jobs, as a `ci/build`
 * run: find the job's snapshot by its name here, or build it and everything it
 * starts from, and give it back.
 *
 * The request has no GitHub event, so a job that reads its repository reads
 * the one this app was deployed from.
 */
export const answerAppJob = async ({
  run,
  data,
  jobs,
}: {
  run: CiRunScope;
  data: CacheBuildData;
  jobs: Map<string, RegisteredJob>;
}): Promise<CacheBuildResult> => {
  const registered = jobs.get(data.jobId);

  if (!registered) {
    throw new NonRetriableError(
      `${run.ci.client.id} defines no job \`${data.jobId}\`. The worker's code may be out of date.`,
    );
  }

  run.repo ??=
    (await ciRun(run, steps.findDeployedRepo(), async () => {
      return deployedRepo() ?? null;
    })) ?? undefined;

  const { config } = registered;

  const input = await validateInput(config, data.input);

  const built = await buildOf(run, {
    config: await withoutUnreusableCache(run, config, input),
    input,
    raw: data.input,
  });

  // The asking run deletes what only it needs, since this one never does.
  return { ...built, createdSnapshots: [...run.createdSnapshots] };
};
