/**
 * Defining and running a pipeline: the `ci.pipeline()` factory, the run itself
 * (scope, checks, cleanup), and the functions generated beside each pipeline
 * and for cache refreshes.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { internalEvents, NonRetriableError } from "inngest";
import type { DurableSandboxTools } from "inngest/experimental";
import { getAsyncCtx, sandboxMiddleware } from "inngest/experimental";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "../errors.ts";
import type { CheckReporter } from "../github/checks.ts";
import { pipelineSummary } from "../github/checks.ts";
import {
  commentAuthor,
  commentBody,
  repoContextFromEvent,
} from "../github/events.ts";
import { canUser } from "../github/helpers.ts";
import { commentPermissionFor, type Permission } from "../github/triggers.ts";
import { destroyRunMachines } from "../machine/machine.ts";
import type {
  CiSkip,
  CiTrigger,
  CiTriggerInput,
  PipelineConfig,
  PipelineContext,
  RepoContext,
} from "../types.ts";
import { formatDuration } from "../util.ts";
import type { RegisteredJob } from "./job.ts";
import { conclusionForError, runJob } from "./job.ts";
import type { CiInternals, CiRunScope } from "./scope.ts";
import { initCiAls, runInScope, withScopePreserved } from "./scope.ts";

export const definePipeline = ({
  client,
  internals,
  jobs,
  rawConfig,
  handler,
}: {
  client: Inngest.Any;
  internals: CiInternals;
  jobs: Map<string, RegisteredJob>;
  rawConfig: PipelineConfig;
  handler: (ctx: PipelineContext) => Promise<unknown>;
}): {
  fn: InngestFunction.Any;
  config: PipelineConfig;
  generated: InngestFunction.Any[];
} => {
  const triggers = flattenTriggers(rawConfig.on);

  if (triggers.length === 0) {
    throw new CiUsageError(
      `Pipeline "${rawConfig.id}" has no triggers. Pass \`on: github.pullRequest()\`, a cron, or \`ci.manual({ schema })\`.`,
    );
  }

  if (triggers.length > maxTriggersPerFunction) {
    throw new CiUsageError(
      `Pipeline "${rawConfig.id}" has ${triggers.length} triggers, and a function can have at most ${maxTriggersPerFunction}. Narrow \`types\` on the trigger, or split the pipeline in two.`,
    );
  }

  // A comment trigger's `minPermission` can't be expressed in CEL, so it
  // travels beside the trigger and is checked when the run starts.
  const permission = triggers
    .map((trigger) => commentPermissionFor(trigger))
    .find(Boolean);

  const config: PipelineConfig = {
    ...rawConfig,
    ...(permission ? { commentPermission: permission.minPermission } : {}),
  };

  const fn = client.createFunction(
    {
      ...flowControl(config),
      id: config.id,
      triggers,
      middleware: [sandboxMiddleware()],
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
    async (ctx: any) => runPipeline({ internals, config, handler, ctx, jobs }),
  );

  return {
    fn,
    config,
    generated: generatedFunctions({ client, config }),
  };
};

/**
 * A function's triggers are declared with it, and the platform caps how many
 * it will take. Ten is the documented limit at the time of writing.
 */
export const maxTriggersPerFunction = 10;

/**
 * `on` takes one trigger or any nesting of arrays of them, since
 * `github.pullRequest()` is itself an array. The executor wants one flat list.
 */
const flattenTriggers = (on: CiTriggerInput): CiTrigger[] =>
  (Array.isArray(on) ? on.flat(Infinity) : [on]) as CiTrigger[];

const flowControl = (config: PipelineConfig) => {
  const {
    id: _id,
    on: _on,
    check: _check,
    machine: _machine,
    repo: _repo,
    commentPermission: _commentPermission,
    ...rest
  } = config;
  return rest;
};

interface RunPipelineArgs {
  internals: CiInternals;
  config: PipelineConfig;
  handler: (ctx: PipelineContext) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
  ctx: any;
  jobs: Map<string, RegisteredJob>;
}

/**
 * Run a pipeline: set up the run scope, report the pipeline check, run the
 * handler, then always complete the check and destroy the machines.
 */
export const runPipeline = async ({
  internals,
  config,
  handler,
  ctx,
}: RunPipelineArgs): Promise<unknown> => {
  await initCiAls();

  const asyncCtx = await getAsyncCtx();
  if (!asyncCtx?.execution) {
    throw new CiUsageError(
      "A pipeline ran without an Inngest execution context. Pipelines must be served through `serve()` with `ci.functions()`.",
    );
  }

  const sandboxTools = (ctx.step as { sandbox?: DurableSandboxTools }).sandbox;

  const run: CiRunScope = {
    ci: internals,
    runId: ctx.runId,
    functionId: config.id,
    pipelineId: config.id,
    ...(config.check === false
      ? {}
      : { checkName: config.check?.name ?? config.id }),
    jobChecks: config.check === false ? false : config.check?.jobs !== false,
    event: ctx.event,
    ...(repoContextFromEvent(ctx.event)
      ? { repo: repoContextFromEvent(ctx.event) as RepoContext }
      : {}),
    jobs: new Map(),
    machines: new Map(),
    snapshots: new Map(),
    cacheEntries: new Map(),
    sandboxes: new Set(),
    summaries: [],
    openChecks: new Map(),
    // CI's own steps keep their scope inside the handler, so a call like
    // `github.rest` made from one still knows which run it's part of.
    step: withScopePreserved(ctx.step),
    sandboxTools: sandboxTools as DurableSandboxTools,
    asyncCtx,
    counters: new Map(),
    snapshotsUnavailable: false,
    warnings: [],
    pipelineSummaries: [],
    pipelineAnnotations: [],
  };

  const checks = internals.checks as CheckReporter;
  const started = Date.now();

  return runInScope({ run }, async () => {
    await checks.pipelineStart({ run });

    try {
      const permitted = await checkCommentPermission(run, config);

      if (!permitted) {
        await checks.pipelineComplete({
          run,
          conclusion: "neutral",
          title: "Not permitted",
          summary: pipelineSummary(run),
        });
        return { skipped: "not permitted" };
      }

      const result = await handler({
        event: ctx.event,
        events: ctx.events ?? [ctx.event],
        runId: ctx.runId,
        pipelineId: config.id,
        repo: run.repo,
        attempt: ctx.attempt ?? 0,
        logger: ctx.logger ?? console,
      });

      const skip = asSkip(result);

      await checks.pipelineComplete({
        run,
        conclusion: "success",
        title: skip ? `Nothing to do: ${skip.reason}` : summaryTitle(run),
        summary: pipelineSummaryWithReports(run),
      });

      return result;
    } catch (error) {
      // Jobs that were still running when the run ended would otherwise leave
      // their checks spinning.
      await closeOpenJobChecks(run, checks);

      await checks.pipelineComplete({
        run,
        conclusion: conclusionForError(error),
        title: errorTitle(error, run),
        summary: pipelineSummaryWithReports(run),
      });

      // A failed command's exit code is already recorded in its steps, so
      // retrying the run would only replay the same failure.
      if (
        error instanceof CommandFailedError ||
        error instanceof CommandTimeoutError
      ) {
        throw new NonRetriableError(error.message, { cause: error });
      }

      throw error;
    } finally {
      void started;
      await destroyRunMachines(run);
    }
  });
};

/**
 * Complete the job checks of anything still running when the run ended.
 *
 * With `Promise.all`, the first failure ends the run while its siblings are
 * mid-flight; their checks are marked cancelled rather than left in progress.
 */
const closeOpenJobChecks = async (
  run: CiRunScope,
  checks: CheckReporter,
): Promise<void> => {
  const open = [...run.openChecks.entries()];
  run.openChecks.clear();

  for (const [jobPath, name] of open) {
    run.summaries.push({
      path: jobPath,
      conclusion: "cancelled",
      title: "Cancelled: the pipeline ended first",
      durationMs: 0,
    });

    await checks.jobComplete({
      run,
      jobPath,
      ...(name ? { name } : {}),
      conclusion: "cancelled",
      title: "Cancelled: the pipeline ended first",
    });
  }
};

const pipelineSummaryWithReports = (run: CiRunScope): string =>
  [pipelineSummary(run), ...run.pipelineSummaries].join("\n\n");

const summaryTitle = (run: CiRunScope): string => {
  const failed = run.summaries.filter(
    (summary) => summary.conclusion !== "success",
  );

  if (failed.length > 0) {
    return `${failed.map((summary) => summary.path).join(", ")} failed`;
  }

  const total = run.summaries.reduce(
    (sum, summary) => sum + summary.durationMs,
    0,
  );

  return run.summaries.length === 0
    ? "Nothing to do"
    : `${run.summaries.length} job${run.summaries.length === 1 ? "" : "s"} passed in ${formatDuration(total)}`;
};

const errorTitle = (error: unknown, run: CiRunScope): string => {
  const failed = run.summaries.find(
    (summary) => summary.conclusion !== "success",
  );

  if (failed) {
    return `${failed.path}: ${failed.title}`;
  }

  return error instanceof Error
    ? (error.message.split("\n")[0] ?? "Failed")
    : "Failed";
};

const asSkip = (result: unknown): CiSkip | undefined =>
  (result as CiSkip | undefined)?.kind === "inngest/ci.skip"
    ? (result as CiSkip)
    : undefined;

/**
 * Comment triggers can't express a permission check in CEL, so it happens here
 * and reports "Not permitted" rather than failing.
 */
const checkCommentPermission = async (
  run: CiRunScope,
  config: PipelineConfig,
): Promise<boolean> => {
  const minPermission = config.commentPermission as Permission | undefined;

  if (!minPermission) {
    return true;
  }

  const event = run.event as { name?: string } | undefined;
  if (!event?.name?.startsWith("github/issue_comment")) {
    return true;
  }

  const login = commentAuthor(run.event as { data?: unknown });
  if (!login) {
    return false;
  }

  const allowed = await canUser(login, minPermission);

  if (!allowed) {
    await run.step.run(
      { id: "github › comment:denied", name: "comment:denied" },
      async () => {
        const { stickyComment } = await import("../github/helpers.ts");
        await stickyComment(
          "permission",
          `@${login} you need \`${minPermission}\` permission to run \`${commentBody(run.event as { data?: unknown }).split(" ")[0]}\`.`,
        );
        return { denied: login };
      },
    );
  }

  return allowed;
};

/**
 * The functions a pipeline needs behind the scenes: cleanup after a permanent
 * failure or cancellation, and re-runs from a GitHub check.
 */
const generatedFunctions = ({
  client,
  config,
}: {
  client: Inngest.Any;
  config: PipelineConfig;
}): InngestFunction.Any[] => {
  const functions: InngestFunction.Any[] = [];

  functions.push(
    client.createFunction(
      {
        id: `${config.id}/cleanup`,
        triggers: [
          {
            event: internalEvents.FunctionFailed,
            if: `event.data.function_id == "${client.id}-${config.id}"`,
          },
          {
            event: internalEvents.FunctionCancelled,
            if: `event.data.function_id == "${client.id}-${config.id}"`,
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
      async ({ event, step }: any) => {
        const runId = event?.data?.run_id ?? event?.data?.runId;

        // A run that ended permanently never reached its own cleanup step, so
        // its machines are found by name. Listing has no name filter, so the
        // comparison happens here.
        return step.run("destroy-orphans", async () => {
          if (!runId) {
            return { destroyed: 0 };
          }

          const prefix = `ci-${runId}-`;
          let cursor: string | undefined;
          let destroyed = 0;

          do {
            const page = await client.sandboxes.list({
              ...(cursor ? { cursor } : {}),
              limit: 100,
            });

            for (const sandbox of page.items) {
              if (sandbox.name.startsWith(prefix)) {
                try {
                  await sandbox.destroy();
                  destroyed++;
                } catch {
                  // Already gone.
                }
              }
            }

            cursor = page.page.hasMore ? page.page.cursor : undefined;
          } while (cursor);

          return { destroyed };
        });
      },
    ),
  );

  functions.push(
    client.createFunction(
      {
        id: `${config.id}/check-rerequested`,
        triggers: [
          { event: "github/check_run.rerequested" },
          { event: "github/check_suite.rerequested" },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
      async ({ event, step }: any) => {
        const { rerunEventFor } = await import("./rerun.ts");
        return rerunEventFor({ event, step, client, config });
      },
    ),
  );

  return functions;
};

/**
 * One function per cached job with `refresh` triggers, so the cache is built
 * ahead of time rather than by whichever pull request gets there first.
 *
 * These are built when `ci.functions()` is called, because a job may be
 * registered after the pipelines that use it, and because a job used by
 * several pipelines still only needs one refresh function.
 */
export const cacheRefreshFunctions = ({
  client,
  internals,
  jobs,
  repo,
}: {
  client: Inngest.Any;
  internals: CiInternals;
  jobs: Map<string, RegisteredJob>;
  repo?: string;
}): InngestFunction.Any[] => {
  const functions: InngestFunction.Any[] = [];

  for (const job of jobs.values()) {
    const refresh = job.config.cache?.refresh;
    if (!refresh || refresh.length === 0) {
      continue;
    }

    const id = `ci/cache-refresh/${job.id}`;

    functions.push(
      client.createFunction(
        {
          id,
          triggers: refresh,
          singleton: { key: `"${job.id}"`, mode: "skip" },
          middleware: [sandboxMiddleware()],
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
        async (ctx: any) =>
          runPipeline({
            internals,
            config: {
              id,
              on: refresh,
              check: false,
              ...(repo ? { repo } : {}),
            },
            handler: async () => {
              const registered = jobs.get(job.id);
              return registered ? jobBodyForRefresh(registered) : null;
            },
            ctx,
            jobs,
          }),
      ),
    );
  }

  return functions;
};

/**
 * A refresh run calls the job the same way a pipeline would, so `from()` and
 * dedupe behave identically.
 */
const jobBodyForRefresh = async (job: RegisteredJob): Promise<unknown> => {
  const { getRunScope } = await import("./scope.ts");
  const run = getRunScope();

  if (!run) {
    return null;
  }

  return runJob({
    internals: run.ci,
    config: job.config,
    handler: job.handler,
    input: undefined,
  });
};
