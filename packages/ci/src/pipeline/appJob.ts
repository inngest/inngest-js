/**
 * Starting from a job another app defines, `image.job("app/job")`: the
 * request a pipeline sends that app's `ci/build`, and how that app answers it.
 *
 * The asking app can't work out another app's names, since it hasn't got its
 * jobs, so it asks for the job itself. The owner resolves the job's whole
 * chain in its own process, building what's missing once for every app that
 * asks, and answers with the snapshot to start from.
 *
 * @module
 */

import { NonRetriableError, referenceFunction } from "inngest";
import type { CachedSnapshot } from "../cache/cache.ts";
import { deployedRepo } from "../github/deployRepo.ts";
import type { BaseImage } from "../image.ts";
import { buildOf } from "../machine/from.ts";
import { errorMessage } from "../util.ts";
import type { CacheBuildData, CacheBuildResult } from "./cacheBuild.ts";
import { cacheBuildFunctionId } from "./cacheBuild.ts";
import type { RegisteredJob } from "./job.ts";
import { adoptBuilt, validateInput } from "./job.ts";
import { ciRun } from "./metadata.ts";
import { ciStep, traceName } from "./names.ts";
import type { CiRunScope } from "./scope.ts";
import { rootRunIdOf, scopeSeparator } from "./scope.ts";

/**
 * The version of the request. An app on another version of `@inngest/ci`
 * refuses a request it can't read, rather than guessing.
 */
export const appJobRequestVersion = 1;

/** What a cycle of jobs across apps says, given the `app/job`s along it. */
const cycleMessage = (path: string[]): string => {
  const named = path
    .map((id) => {
      return `\`${id}\``;
    })
    .join(" → ");

  return `${named} starts from itself.`;
};

/** What another app asks for when a job starts from one of this app's. */
export interface AppJobRequest {
  version: number;
  /** The job's ID in this app. */
  job: string;
  /** The app that asked. */
  from: string;
  /**
   * The `app/job`s whose resolving led here, outermost first, so a cycle
   * across apps fails instead of asking forever.
   */
  chain: string[];
}

/**
 * Get the snapshot of another app's job: one invoke of that app's `ci/build`,
 * which answers once it has found or built it.
 */
export const requestAppJob = async (
  run: CiRunScope,
  image: BaseImage,
  /** The step's ID, which is fixed for the image. */
  stepId: string,
): Promise<CachedSnapshot> => {
  const app = image.app as string;
  const job = image.job as string;
  const self = run.ci.client.id;
  const asking = run.build?.resolve;

  const chain = asking ? [...asking.chain, `${self}/${asking.job}`] : [];

  // A request holds its job's one slot while it waits on what it asks for, so
  // asking again for a job already on the way would wait on itself forever.
  if (chain.includes(`${app}/${job}`)) {
    throw new NonRetriableError(cycleMessage([...chain, `${app}/${job}`]));
  }

  const resolve: AppJobRequest = {
    version: appJobRequestVersion,
    job,
    from: self,
    chain,
  };

  const rootRunId = rootRunIdOf(run);

  const data: CacheBuildData = {
    jobId: `image ${image.name}`,
    ...(image.input === undefined ? {} : { input: image.input }),
    ownKey: "",
    // One request per job and input at a time, so a burst of apps asking for
    // the same job builds it once.
    cacheKey: `image:${image.name}`,
    resolve,
    rootRunId,
    parent: {
      runId: rootRunId,
      pipelineId: run.build?.parent.pipelineId ?? run.pipelineId,
      jobPath: `image ${image.name}`,
      trigger:
        run.build?.parent.trigger ??
        (run.event as { name?: string })?.name ??
        "manual",
    },
  };

  let built: CacheBuildResult | null;

  try {
    built = (await run.step.invoke(
      ciStep(stepId, traceName.buildAppJob(image.name)),
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
      `\`${image.name}\` couldn't be built by \`${app}\`: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!built?.snapshotId) {
    throw new NonRetriableError(
      `\`${image.name}\` has no snapshot to start from: it ran no commands, or \`${app}\` couldn't take one.`,
    );
  }

  // A snapshot only this run needs is this run's to delete when it ends.
  adoptBuilt(run, built);

  return {
    snapshotId: built.snapshotId,
    name: built.cached?.name ?? image.name,
    createdAt: built.cached?.createdAt ?? "",
  };
};

/**
 * Answer another app's request for one of this app's jobs, as a `ci/build`
 * run: find the job's snapshot by its name here, or build it, and everything
 * it starts from, and give it back.
 *
 * The request has no GitHub event, so a job that reads its repository reads
 * the one this app was deployed from.
 */
export const answerAppJob = async ({
  run,
  request,
  input,
  jobs,
}: {
  run: CiRunScope;
  request: AppJobRequest;
  /** The job's input, as the asking app gave it. */
  input: unknown;
  jobs: Map<string, RegisteredJob>;
}): Promise<CacheBuildResult> => {
  const self = run.ci.client.id;

  if (request.version !== appJobRequestVersion) {
    throw new NonRetriableError(
      `\`${request.from}\` asked for \`${self}/${request.job}\` with a request this version of @inngest/ci can't read (version ${request.version}, expected ${appJobRequestVersion}). Update @inngest/ci in both apps.`,
    );
  }

  const path = [...request.chain, `${self}/${request.job}`];

  if (request.chain.includes(`${self}/${request.job}`)) {
    throw new NonRetriableError(cycleMessage(path));
  }

  const registered = jobs.get(request.job);

  if (!registered) {
    throw new NonRetriableError(
      `\`${request.from}\` asked for \`${self}/${request.job}\`, but this app defines no job \`${request.job}\`.`,
    );
  }

  run.repo ??= await deployedRepoStep(run);

  const config = registered.config;

  // Taken as this run's concern inside, like any build it asks for.
  const built = await buildOf(
    run,
    {
      config,
      input: await validateInput(config, input),
      raw: input,
    },
    // The job itself is the start of the chain that guards `from` cycles here.
    [config.id],
  );

  // The asking run deletes what only it needs, since this one never does.
  return { ...built, createdSnapshots: [...run.createdSnapshots] };
};

/** Where this app was deployed from, read once, as a memoized step. */
const deployedRepoStep = async (run: CiRunScope) => {
  const found = await ciRun(
    run,
    {
      step: ciStep(`deploy${scopeSeparator}repo`, traceName.findDeployedRepo),
      intent: "Find the repository and commit this app was deployed from",
    },
    async (note) => {
      const repo = deployedRepo();

      note.outcome(
        repo
          ? { repo: repo.fullName, sha: repo.sha, ref: repo.ref }
          : { repo: null },
      );

      return repo ?? null;
    },
  );

  return found ?? undefined;
};
