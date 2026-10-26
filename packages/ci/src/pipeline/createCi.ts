/**
 * The CI client: `createCi()`, its options and the `Ci` interface. It wires the
 * pipeline and job definitions to a shared set of internals (checks,
 * the cache build function, GitHub provider).
 *
 * @module
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Inngest, InngestFunction } from "inngest";
import { CiUsageError } from "../errors.ts";
import type { ConsoleProvider, GitHubProvider } from "../github/auth.ts";
import { consoleReporter } from "../github/auth.ts";
import type { CheckSink } from "../github/checks.ts";
import {
  checksSink,
  consoleSink,
  createCheckReporter,
  noopSink,
  statusesSink,
} from "../github/checks.ts";
import { setFallbackGitHub } from "../github/rest.ts";
import type {
  CacheConfig,
  CacheKey,
  CiSkip,
  CiTrigger,
  CiTriggerInput,
  From,
  Job,
  JobConfig,
  JobContext,
  JobOutput,
  MachineConfig,
  MatrixAxes,
  MatrixCombo,
  MatrixContext,
  MatrixJob,
  MatrixJobConfig,
  NoFrom,
  PipelineConfig,
  PipelineContext,
} from "../types.ts";
import { cacheBuildFunction, cacheBuildFunctionId } from "./cacheBuild.ts";
import { snapshotCleanupFunction } from "./cleanup.ts";
import { noopHooks } from "./hooks.ts";
import type { RegisteredJob } from "./job.ts";
import { defineJob } from "./job.ts";
import { createMatrix } from "./matrix.ts";
import {
  cacheRefreshFunctions,
  cleanupFunction,
  definePipeline,
} from "./pipeline.ts";
import { prCacheFunction } from "./prCache.ts";
import type { CiInternals } from "./scope.ts";
import { getRunScope } from "./scope.ts";

export interface CiOptions {
  /**
   * How pipelines talk to GitHub. Defaults to `consoleReporter()`, which
   * prints checks to the Inngest logger instead of sending them to GitHub.
   */
  github?: GitHubProvider;
  /** Default machine for jobs. */
  machine?: MachineConfig;
  /** Builds the link shown on checks. */
  runUrl?: (ctx: { runId: string; functionId: string }) => string;
}

export interface Ci {
  /**
   * Define a pipeline: what starts it, and what it does.
   *
   * A pipeline is one Inngest function run. `event` in the handler is typed by
   * the triggers you give it.
   *
   * ```ts
   * export const pr = ci.pipeline(
   *   { id: "pr", on: github.pullRequest() },
   *   async ({ event }) => {
   *     await Promise.all([lint(), test()]);
   *     await deploy(event.data.pull_request.head.sha);
   *   },
   * );
   * ```
   */
  pipeline<const TTriggers extends CiTriggerInput>(
    config: PipelineConfig<TTriggers>,
    handler: (ctx: PipelineContext<TTriggers>) => Promise<unknown>,
  ): InngestFunction.Any;

  /**
   * Define a job: a unit of work with its own machine, called like a function.
   *
   * Its input is inferred from the handler. Every call runs the job again, on
   * its own machine and with its own check, named `test (2)` the second time.
   * A job that starts `from` another runs on a copy of its machine, which is
   * made before the handler runs because that is where the outputs of the jobs
   * above it are kept.
   *
   * ```ts
   * const test = ci.job("test", async () => {
   *   await checkout();
   *   await $`pnpm test`;
   * });
   *
   * const compat = ci.job("compat", async ({ input }: { input: string }) => {
   *   await $`fnm use ${input}`;
   * });
   * ```
   *
   * Give it an `input` schema to validate the input:
   *
   * ```ts
   * const build = ci.job(
   *   { id: "build", input: z.object({ target: z.enum(["web", "api"]) }) },
   *   async ({ input }) => {
   *     await $`pnpm build --target ${input.target}`;
   *   },
   * );
   * ```
   *
   * The handler is given the job's `id`, the `key` its cache was made of, its
   * `input`, and what it started `from`.
   *
   * What the handler returns is the job's output: an object of JSON values and
   * commands. Jobs that start `from` it get the data as `from.output` and the
   * commands as `from.$`, and an uncached job resolves to its data.
   *
   * ```ts
   * const base = ci.job("base", async () => {
   *   await $`pnpm install`;
   *
   *   return { version: await $`pnpm --version`.text(), dev: $`pnpm dev` };
   * });
   *
   * const test = ci.job({ id: "test", from: base }, async ({ from }) => {
   *   from.output.version; // "9.1.0"
   *
   *   await from.$.dev.background();
   * });
   * ```
   *
   * A job's output describes its image as it was built, so it doesn't change
   * when the image is reused, and a command in it is a command rather than a
   * process: nothing the job started is running in jobs that start from it.
   * Awaiting a command in the return value runs it while the job builds.
   * Outputs are stored in the image, with a command's environment, so don't
   * put secrets in either.
   *
   * Give it a `matrix` to get one job per combination of its axes. Axis
   * values keep their literal types, so the handler's `matrix` is exact and a
   * typo in `exclude` or in `compat({ … })` is a type error. Call the job to
   * run every combination, or pass part of one to run only what matches.
   *
   * ```ts
   * const compat = ci.job(
   *   { id: "compat", matrix: { axes: { node: ["20", "22"] } } },
   *   async ({ matrix }) => {
   *     await $`pnpm test`.env({ NODE_VERSION: matrix.node });
   *   },
   * );
   * ```
   *
   * `matrix.axes` can be an async function of what the run knows, like the commit.
   * It is called once per run, and the job can still be defined at the top
   * level.
   *
   * ```ts
   * const examples = ci.job(
   *   {
   *     id: "examples",
   *     matrix: {
   *       axes: async ({ repo }) => {
   *         const entries = await github.rest.repos.getContent({
   *           path: "examples",
   *           ref: repo?.sha ?? "",
   *         });
   *
   *         const dirs = Array.isArray(entries) ? entries : [];
   *
   *         return { example: dirs.map((entry) => entry.name) };
   *       },
   *     },
   *   },
   *   async ({ matrix }) => {
   *     await $`pnpm test`.env({ EXAMPLE: matrix.example });
   *   },
   * );
   * ```
   */
  job<
    const TAxes extends MatrixAxes,
    TFrom extends From<MatrixCombo<TAxes>> | undefined = NoFrom<
      MatrixCombo<TAxes>
    >,
  >(
    config: MatrixJobConfig<TAxes, TFrom>,
    handler: (
      ctx: MatrixContext<TAxes, Record<string, string>, TFrom>,
    ) => Promise<void>,
  ): MatrixJob<TAxes>;
  job<
    TSchema extends StandardSchemaV1,
    const TKey extends CacheKey | undefined = undefined,
    TFrom extends
      | From<StandardSchemaV1.InferOutput<TSchema>>
      | undefined = NoFrom<StandardSchemaV1.InferOutput<TSchema>>,
    TOutput extends JobOutput = void,
    TCache extends CacheConfig | undefined = undefined,
  >(
    config: JobConfig<StandardSchemaV1.InferOutput<TSchema>, TKey, TFrom> & {
      input: TSchema;
      cache?: TCache;
    },
    handler: (
      ctx: JobContext<StandardSchemaV1.InferOutput<TSchema>, TKey, TFrom>,
    ) => Promise<TOutput>,
  ): Job<StandardSchemaV1.InferInput<TSchema>, TKey, TFrom, TOutput, TCache>;
  job<
    TInput = void,
    const TKey extends CacheKey | undefined = undefined,
    TFrom extends From<TInput> | undefined = NoFrom<TInput>,
    TOutput extends JobOutput = void,
    TCache extends CacheConfig | undefined = undefined,
  >(
    idOrConfig: string | (JobConfig<TInput, TKey, TFrom> & { cache?: TCache }),
    handler: (ctx: JobContext<TInput, TKey, TFrom>) => Promise<TOutput>,
  ): Job<TInput, TKey, TFrom, TOutput, TCache>;
  job<TInput>(
    idOrConfig: string | JobConfig<TInput>,
    handler: (
      ctx: JobContext<TInput, CacheKey | undefined, From<TInput> | undefined>,
    ) => Promise<void>,
  ): Job<TInput>;

  /**
   * A manual trigger with a typed payload, sent as `ci/manual.<pipelineId>`.
   *
   * ```ts
   * ci.pipeline(
   *   {
   *     id: "deploy",
   *     on: ci.manual({
   *       pipelineId: "deploy",
   *       schema: z.object({ environment: z.enum(["preview", "production"]) }),
   *     }),
   *   },
   *   async ({ event }) => {
   *     event.data.environment; // "preview" | "production"
   *   },
   * );
   * ```
   */
  manual<TSchema extends StandardSchemaV1>(opts: {
    /** The payload's schema, which types `event.data` in the handler. */
    schema: TSchema;
    /** The pipeline this trigger is for. Defaults to any pipeline. */
    pipelineId?: string;
  }): CiTrigger<StandardSchemaV1.InferOutput<TSchema>>;

  /**
   * End a pipeline early, with a reason shown on the check.
   *
   * The check still completes as success, so a required check never hangs.
   *
   * ```ts
   * if (!(await changed("src/**"))) {
   *   return ci.skip("nothing under src changed");
   * }
   * ```
   */
  skip(reason: string): CiSkip;

  /**
   * Every function to pass to `serve()`: your pipelines, plus the ones CI
   * needs behind the scenes for cleanup, cache refreshes, and re-runs.
   *
   * ```ts
   * export const { GET, POST, PUT } = serve({
   *   client: inngest,
   *   functions: ci.functions(),
   * });
   * ```
   */
  functions(): InngestFunction.Any[];
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Create a CI client from an Inngest client.
 *
 * ```ts
 * export const ci = createCi(inngest, {
 *   github: githubApp({ appId, privateKey }),
 * });
 * ```
 */
export const createCi = (client: Inngest.Any, options: CiOptions = {}): Ci => {
  // Read on use rather than here: the client resolves its mode from env vars
  // that some runtimes only provide per request.
  const isDev = () => {
    return client.mode === "dev";
  };

  // The provider answers `github.rest` and `github.token()` whatever mode
  // we're in; only where checks *go* changes in dev.
  const provider = options.github ?? consoleReporter();
  const jobs = new Map<string, RegisteredJob>();
  const matrices = new Map<string, MatrixJob<MatrixAxes>>();
  const hooks = noopHooks;
  let buildFunction: InngestFunction.Any | undefined;

  const internals: CiInternals = {
    client,
    isDev,
    github: provider,
    checks: createCheckReporter(
      hooks.wrapSink(sinkFor(provider, client, isDev)),
    ),
    hooks,
    jobs,
    // One build function for every job and matrix, made when first needed
    // so a pipeline can invoke it whether or not `functions()` has run.
    cacheBuild: () => {
      buildFunction ??= cacheBuildFunction({
        client,
        internals,
        jobs,
        matrices,
      });

      return buildFunction;
    },
    ...(options.machine ? { defaultMachine: options.machine } : {}),
    runUrl: options.runUrl ?? defaultRunUrl(client, isDev),
    logger: (
      client as unknown as { logger?: { warn: (...args: unknown[]) => void } }
    ).logger,
  };

  setFallbackGitHub(provider);

  const generated: InngestFunction.Any[] = [];
  const pipelines: InngestFunction.Any[] = [];

  /** The first `repo` a pipeline set, used by refresh runs that have none. */
  let pipelineRepo: string | undefined;

  const ci: Ci = {
    pipeline: (rawConfig, handler) => {
      const {
        fn,
        config,
        generated: extra,
      } = definePipeline({
        client,
        internals,
        rawConfig,
        handler,
      });

      pipelineRepo ??= config.repo;

      pipelines.push(fn);

      generated.push(...extra);

      return fn;
    },

    // biome-ignore lint/suspicious/noExplicitAny: overloaded signature
    job: ((idOrConfig: any, handler: any) => {
      if (typeof idOrConfig === "string" || !("matrix" in idOrConfig)) {
        return defineJob({ jobs, idOrConfig, handler });
      }

      // Inside a run, a matrix is rebuilt per call, so the same ID again is
      // expected, as it is for jobs.
      if (matrices.has(idOrConfig.id) && !getRunScope()) {
        throw new CiUsageError(
          `Matrix IDs must be unique per app, and "${idOrConfig.id}" is already defined.`,
        );
      }

      const matrix = createMatrix({
        ci,
        jobs,
        config: idOrConfig,
        handler,
      });

      matrices.set(idOrConfig.id, matrix as MatrixJob<MatrixAxes>);

      return matrix;
      // biome-ignore lint/suspicious/noExplicitAny: overloaded signature
    }) as any,

    manual: (opts) => {
      return {
        event: `ci/manual.${opts.pipelineId ?? "*"}`,
        ...(opts.schema ? { schema: opts.schema } : {}),
      };
    },

    skip: (reason) => {
      return { kind: "inngest/ci.skip", reason };
    },

    functions: () => {
      return [
        ...pipelines,
        ...generated,
        // Any job can be started from, so one function builds them all.
        internals.cacheBuild(),
        cleanupFunction({ client, config: { id: cacheBuildFunctionId } }),
        snapshotCleanupFunction(client),
        prCacheFunction({ client }),
        ...cacheRefreshFunctions({
          client,
          internals,
          jobs,
          ...(pipelineRepo ? { repo: pipelineRepo } : {}),
        }),
      ];
    },
  };

  return ci;
};

/**
 * Where checks go.
 *
 * In dev they print to the terminal, whatever the provider is, unless the run
 * is explicitly told to talk to GitHub with `INNGEST_CI_GITHUB=live`. The
 * provider is still used for `github.rest` and `github.token()`, because those
 * always need real credentials.
 */
const sinkFor = (
  provider: GitHubProvider,
  client: Inngest.Any,
  isDev: () => boolean,
): CheckSink => {
  const logger = (
    client as unknown as {
      logger?: { info: (...args: unknown[]) => void };
    }
  ).logger;

  const toConsole = consoleSink(
    logger,
    (provider as ConsoleProvider).history ?? consoleHistory,
  );

  if (provider.reporter === "console") {
    return toConsole;
  }

  const toGitHub =
    provider.reporter === "checks"
      ? checksSink(provider)
      : provider.reporter === "statuses"
        ? statusesSink(provider)
        : noopSink;

  // Chosen per call, because whether we're in dev is only known once the
  // client has its env vars.
  const pick = () => {
    return isDev() && process.env.INNGEST_CI_GITHUB !== "live"
      ? toConsole
      : toGitHub;
  };

  return {
    start: (args) => {
      return pick().start(args);
    },
    complete: (args) => {
      return pick().complete(args);
    },
    update: async (args) => {
      await pick().update?.(args);
    },
    closeOpen: async (args) => {
      await pick().closeOpen?.(args);
    },
    annotate: async (args) => {
      await pick().annotate?.(args);
    },
  };
};

/**
 * Check transitions printed for a provider that doesn't keep its own history.
 */
const consoleHistory: Parameters<typeof consoleSink>[1] = [];

const defaultRunUrl = (client: Inngest.Any, isDev: () => boolean) => {
  return ({ runId }: { runId: string; functionId: string }) => {
    if (isDev()) {
      const base =
        process.env.INNGEST_DEV_SERVER_URL ??
        process.env.INNGEST_BASE_URL ??
        "http://localhost:8288";

      return `${base.replace(/\/$/, "")}/run?runID=${runId}`;
    }

    const env =
      process.env.INNGEST_ENV ??
      (client as unknown as { env?: string }).env ??
      "production";

    return `https://app.inngest.com/env/${env}/runs/${runId}`;
  };
};
