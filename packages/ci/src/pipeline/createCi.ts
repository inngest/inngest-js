/**
 * The CI client: `createCi()`, its options and the `Ci` interface. It wires the
 * pipeline, job and matrix definitions to a shared set of internals (checks,
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
  CiSkip,
  CiTrigger,
  CiTriggerInput,
  Job,
  JobConfig,
  MachineConfig,
  Matrix,
  MatrixAxes,
  MatrixCombo,
  MatrixConfig,
  PipelineConfig,
  PipelineContext,
} from "../types.ts";
import { cacheBuildFunction, cacheBuildFunctionId } from "./cacheBuild.ts";
import { noopHooks } from "./hooks.ts";
import type { RegisteredJob } from "./job.ts";
import { defineJob } from "./job.ts";
import { createMatrix } from "./matrix.ts";
import {
  cacheWarmFunctions,
  cleanupFunction,
  definePipeline,
} from "./pipeline.ts";
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
   * A job that starts `from` another runs on a copy of its machine. A job has
   * no return value, and a handler that returns one is a type error.
   *
   * ```ts
   * const test = ci.job("test", async () => {
   *   await checkout();
   *   await $`pnpm test`;
   * });
   *
   * const compat = ci.job("compat", async (node: string) => {
   *   await $`fnm use ${node}`;
   * });
   * ```
   *
   * Give it an `input` schema to validate the input:
   *
   * ```ts
   * const build = ci.job(
   *   { id: "build", input: z.object({ target: z.enum(["web", "api"]) }) },
   *   async ({ target }) => {
   *     await $`pnpm build --target ${target}`;
   *   },
   * );
   * ```
   */
  job<TSchema extends StandardSchemaV1>(
    config: JobConfig<StandardSchemaV1.InferOutput<TSchema>> & {
      input: TSchema;
    },
    handler: (input: StandardSchemaV1.InferOutput<TSchema>) => Promise<void>,
  ): Job<StandardSchemaV1.InferInput<TSchema>>;
  job<TInput = void>(
    idOrConfig: string | JobConfig<TInput>,
    handler: (input: TInput) => Promise<void>,
  ): Job<TInput>;

  /**
   * Define a matrix: one job per combination of the axes.
   *
   * Axis values keep their literal types, so the handler's `combo` is exact
   * and a typo in `exclude` or in `matrix({ … })` is a type error.
   *
   * ```ts
   * const compat = ci.matrix(
   *   { id: "compat", axes: { node: ["20", "22"] } },
   *   async ({ node }) => {
   *     await $`pnpm test`.env({ NODE_VERSION: node });
   *   },
   * );
   * ```
   */
  matrix<const TAxes extends MatrixAxes>(
    config: MatrixConfig<TAxes>,
    handler: (combo: MatrixCombo<TAxes>) => Promise<void>,
  ): Matrix<TAxes>;

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
   * needs behind the scenes for cleanup, cache warming, and re-runs.
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
  const matrices = new Map<string, Matrix<MatrixAxes>>();
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

  /** The first `repo` a pipeline set, used by warm runs that have none. */
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
      return defineJob({ jobs, idOrConfig, handler });
      // biome-ignore lint/suspicious/noExplicitAny: overloaded signature
    }) as any,

    matrix: (config, handler) => {
      // Inside a run, a matrix is rebuilt per call, so the same ID again is
      // expected, as it is for jobs.
      if (matrices.has(config.id) && !getRunScope()) {
        throw new CiUsageError(
          `Matrix IDs must be unique per app, and "${config.id}" is already defined.`,
        );
      }

      const matrix = createMatrix(ci, config, handler);

      matrices.set(config.id, matrix as Matrix<MatrixAxes>);

      return matrix;
    },

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
        ...cacheWarmFunctions({
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
