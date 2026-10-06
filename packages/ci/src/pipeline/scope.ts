/**
 * The run and job scopes held in async context: what a running pipeline or
 * job knows about itself, and the helpers that read them.
 *
 * @module
 */

import type { GetStepTools, Inngest, InngestFunction } from "inngest";
import type { AsyncContext, DurableSandboxTools } from "inngest/experimental";
import { getAsyncCtx, runWithAsyncCtx } from "inngest/experimental";
import type { CachedSnapshot } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import type { LocalReporter } from "../local/reporter.ts";
import type { SnapshotParent } from "../machine/snapshotMeta.ts";
import type {
  CheckAnnotation,
  CheckConclusion,
  JobConfig,
  MachineConfig,
  RepoContext,
} from "../types.ts";
import type { CacheBuildData, CacheBuildResult } from "./cacheBuild.ts";
import { ciSpan, traceName } from "./names.ts";
import { inSpan } from "./spans.ts";

/**
 * The separator used between parts of a scope path and a step label. It's a
 * single character that never appears in job IDs in practice, so paths stay
 * readable in the trace.
 */
export const scopeSeparator = " › ";

/** What a rebuilt job's path adds to its ID, as in `base (rebuild)`. */
export const rebuildSuffix = " (rebuild)";

/** The default working directory, which is where `checkout()` puts the repo. */
export const defaultCwd = "/work";

/**
 * Where a job keeps its handler, so `from()` can re-run it on another machine
 * when there are no snapshots to copy from.
 */
export const jobHandlerKey = Symbol("inngest/ci.jobHandler");

/**
 * Where a matrix combination's job config remembers the matrix and combination
 * it came from, so its snapshot is built by the matrix's build function.
 */
export const matrixOriginKey = Symbol("inngest/ci.matrixOrigin");

/** The matrix and combination a job was expanded from, if it was. */
export const matrixOriginOf = (
  config: JobConfig,
): { id: string; combo: Record<string, unknown> } | undefined => {
  return (
    config as unknown as {
      [matrixOriginKey]?: { id: string; combo: Record<string, unknown> };
    }
  )[matrixOriginKey];
};

/**
 * A machine held by a job or an extra machine scope. It's a promise so
 * concurrent first commands share one creation.
 */
export interface MachineHandle {
  /** The durable sandbox, as returned by `step.sandbox.create`. */
  // biome-ignore lint/suspicious/noExplicitAny: DurableSandbox, kept loose to avoid a cycle
  sandbox: any;
  name: string;
  id: string;
  /**
   * Processes this run has already started on the machine, so reconciling an
   * ambiguous start never adopts one of them.
   */
  claimedProcessIds?: Set<string>;
  /**
   * The git tree ID of the working tree this machine has, from its last local
   * `checkout()` or the snapshot it started from. A later `checkout()` uploads
   * only what changed since.
   */
  treeId?: string;
  /**
   * The cached snapshots this machine was built from, all the way up, which
   * its own snapshot records so a restore can check they are still current.
   */
  parents: Record<string, SnapshotParent>;
}

/**
 * A cached job's snapshot that this run uses, whether it was found by name or
 * built for the run.
 */
export interface CachedJob extends CachedSnapshot {
  /** The job's resolved key, for a rebuild. */
  ownKey: string;
  /** The name the job's snapshot is written under, for a rebuild. */
  writeName: string;
  /** Whether it was already there, rather than built for this run. */
  restored: boolean;
}

/** How long a slow step took, for the run's timing summary. */
export interface StepTiming {
  /** What was timed: `upload`, `snapshot`, `start`. */
  kind: string;
  /** The job that waited on it. */
  path: string;
  durationMs: number;
  /** Bytes moved, for an upload. */
  bytes?: number;
}

export interface JobSummary {
  path: string;
  conclusion: CheckConclusion;
  title: string;
  durationMs: number;
  /** Set when the job was restored from cache. */
  cached?: boolean;
  /** Set when `keepOnFailure` snapshotted the machine. */
  keptSnapshotId?: string;
}

/**
 * Everything a run needs from the CI client, without importing `createCi` and
 * making a cycle.
 */
export interface CiInternals {
  /** Reports checks to GitHub, the console, or nowhere. */
  // biome-ignore lint/suspicious/noExplicitAny: CheckReporter, kept loose to avoid a cycle
  checks: any;
  // biome-ignore lint/suspicious/noExplicitAny: GitHubProvider, kept loose to avoid a cycle
  github: any;
  /** Every job defined on the client, so a cache key can look up its parents. */
  jobs: Map<
    string,
    {
      config: JobConfig;
      // biome-ignore lint/suspicious/noExplicitAny: user handler
      handler: (input: any) => Promise<void>;
    }
  >;
  defaultMachine?: { vcpu?: 1 | 2 | 4 };
  runUrl: (ctx: { runId: string; functionId: string }) => string;
  /** Tells the `inngest-ci` CLI what's happening, when it started the app. */
  reporter: LocalReporter;
  // biome-ignore lint/suspicious/noExplicitAny: Inngest.Any
  client: any;
  /**
   * The function that builds the cached snapshots of a job, or of a matrix's
   * combinations, in a run of its own. `target` is the job or matrix ID.
   */
  cacheBuild: (target: string) => InngestFunction.Any;
  isDev: () => boolean;
  // biome-ignore lint/suspicious/noExplicitAny: any logger-ish
  logger?: { warn: (...args: any[]) => void };
}

/**
 * The public APIs counted in run metadata. Each is counted where it's called,
 * so the counts say which parts of `@inngest/ci` a run used.
 */
export const apiNames = [
  "from",
  "matrix",
  "cache",
  "sandbox",
  "checkout",
  "changed",
  "report",
  "githubRest",
  "githubHelpers",
  "waitForChecks",
  "waitForWorkflow",
  "waitFor",
  "commands",
  "background",
  "shard",
  "skip",
] as const;

export type ApiName = (typeof apiNames)[number];

export interface CiRunScope {
  ci: CiInternals;
  runId: string;
  functionId: string;
  pipelineId: string;
  /** The pipeline check's name. `undefined` when checks are off. */
  checkName?: string;
  jobChecks: boolean;
  /** The pipeline's default machine, for jobs that set none. */
  machine?: MachineConfig;
  event: unknown;
  repo?: RepoContext;
  /**
   * The first run of each job in this pipeline run, keyed by job ID. It's the
   * shared one `from()` copies from. Later direct calls aren't stored.
   */
  jobs: Map<string, Promise<void>>;
  /**
   * Cached jobs being rebuilt after their snapshot went bad, keyed by the
   * rebuild's path, so jobs that find the same bad snapshot share one build.
   */
  rebuilds?: Map<string, Promise<CacheBuildResult>>;
  /** How many runs of each job have started, keyed by job ID. */
  jobCalls: Map<string, number>;
  /**
   * The jobs that started `from()` each job, keyed by the parent's job ID and
   * holding the children's paths.
   */
  fromChildren: Map<string, Set<string>>;
  /** Machines created in this run, keyed by scope path. */
  machines: Map<string, Promise<MachineHandle>>;
  /**
   * Pauses of finished jobs' machines that were started and not awaited, keyed
   * by scope path. Each never rejects: a failed pause is a run warning. The
   * map is made with this attempt's scope, so a retry never sees a stale one.
   */
  pauses: Map<string, Promise<void>>;
  /** Snapshots taken of finished jobs, keyed by job path. */
  snapshots: Map<string, Promise<string | undefined>>;
  /**
   * Snapshots this run took itself, by ID. They are deleted when the run ends,
   * so a snapshot a later run can find (a named cache snapshot) or one the run
   * keeps (`keepOnFailure`) is removed from here, and one it only restored is
   * never added.
   */
  createdSnapshots: Set<string>;
  /** How long the slow steps took, in the order they finished. */
  timings: StepTiming[];
  /** The cached snapshots this run uses, keyed by job ID. */
  cached: Map<string, CachedJob>;
  /**
   * One per snapshot a job started from this run. The first job to use a
   * snapshot starts a machine from it and settles this with the snapshot every
   * job should use: the same one if it started, or the rebuilt parent's if it
   * didn't. Jobs that come later wait on it rather than probe again.
   */
  snapshotProbes?: Map<string, Promise<string | undefined>>;
  /**
   * Set when this run is a cache build: one job's snapshot, built for the run
   * that invoked it. It has no checks of its own and reports to that run.
   */
  build?: CacheBuildData;
  /** Sandbox IDs created in this run, for cleanup. */
  sandboxes: Set<string>;
  /** Job results in call order, for the pipeline check summary. */
  summaries: JobSummary[];
  /**
   * Job checks that have started and not finished. When a run ends while jobs
   * are still going, these are completed rather than left spinning.
   */
  openChecks: Map<string, string | undefined>;
  /**
   * Job checks whose job failed with an error Inngest will retry. They stay in
   * progress with their result held back, because a later attempt may pass.
   */
  deferredChecks: Map<
    string,
    {
      name?: string;
      conclusion: CheckConclusion;
      title: string;
      summary: string;
      annotations: CheckAnnotation[];
    }
  >;
  /** This attempt, counting from 0. */
  attempt: number;
  /** How many attempts Inngest makes in all. */
  maxAttempts: number;
  /** Whether Inngest will run the function again after this error. */
  willRetry: (error: unknown) => boolean;
  /** The run's logger, which writes into the trace. */
  logger?: { debug?: (...args: unknown[]) => void };
  /** Raw step tools for CI's own steps. IDs are written in full. */
  step: GetStepTools<Inngest.Any>;
  sandboxTools: DurableSandboxTools;
  /** The SDK async context this run is nested in. */
  asyncCtx: AsyncContext;
  /** Step ID counters, keyed by the ID's base. */
  counters: Map<string, number>;
  /** Set when snapshots turned out to be unavailable, so `from()` fell back. */
  snapshotsUnavailable: boolean;
  /** Warnings to surface on the pipeline check. */
  warnings: string[];
  /** The run's changed files, resolved once. */
  changedFiles?: string[];
  /** Markdown added with `report.summary()` outside a job. */
  pipelineSummaries: string[];
  /** Annotations added with `report.annotate()` outside a job. */
  pipelineAnnotations: CheckAnnotation[];
  /** How many times each public API was called in this run. */
  apis: Record<ApiName, number>;
}

export interface CiJobScope {
  run: CiRunScope;
  /** The job's path, which is its ID for a job and `${job} › ${name}` for an extra machine. */
  path: string;
  /** The owning job's path. Same as `path` unless this is an extra machine. */
  jobPath: string;
  config: JobConfig;
  machine?: Promise<MachineHandle>;
  fromSnapshotId?: string;
  /** Re-runs the `from()` parent on this job's machine. Set by `from()`. */
  rebuildParent?: () => Promise<void>;
  /**
   * Runs the `from()` parent again as a job of its own, once per run, and
   * gives its new snapshot. Set by `from()`.
   */
  rebuildSnapshot?: () => Promise<string | undefined>;
  /**
   * `rebuildParent`, once the snapshot wouldn't start and a fresh machine
   * has to be brought to where the snapshot would have been.
   */
  restoreFallback?: () => Promise<void>;
  /** What the job's first machine is for, shown while it starts. */
  startNote?: string;
  /** Set while `restoreFallback` runs, whose own commands must not wait on it. */
  restoringFallback?: boolean;
  /** The one run of `restoreFallback`, shared by concurrent first commands. */
  fallbackRan?: Promise<void>;
  fromCalled: boolean;
  fromJobIds: string[];
  /** The input each `from()` parent was called with, by job ID. */
  parentInputs: Record<string, unknown>;
  annotations: CheckAnnotation[];
  /** Extra summary markdown added with `report.summary`. */
  summaries: string[];
  /** Environment defaults for commands in this scope. */
  env: Record<string, string>;
  cwd?: string;
  /** Secret values to mask in output. */
  secrets: string[];
  /** Extra machines created in this job with `sandbox()`, keyed by name. */
  extras?: Map<string, CiJobScope>;
}

interface CiStore {
  run?: CiRunScope;
  job?: CiJobScope;
}

type CiAls = {
  getStore(): CiStore | undefined;
  run<R>(store: CiStore, fn: () => R): R;
};

const fallbackAls: CiAls = {
  getStore: () => {
    return undefined;
  },
  run: (_store, fn) => {
    return fn();
  },
};

let resolvedAls: CiAls | undefined;
let alsPromise: Promise<CiAls> | undefined;

/**
 * CI keeps its own async local storage, nested inside the SDK's. It's loaded
 * lazily so importing `inngest/ci` doesn't require `node:async_hooks`.
 */
export const initCiAls = async (): Promise<CiAls> => {
  if (resolvedAls) {
    return resolvedAls;
  }

  alsPromise ??= (async () => {
    try {
      const { AsyncLocalStorage } = await import("node:async_hooks");

      resolvedAls = new AsyncLocalStorage<CiStore>();
    } catch {
      resolvedAls = fallbackAls;
    }

    return resolvedAls;
  })();

  return alsPromise;
};

const getStore = (): CiStore | undefined => {
  return resolvedAls?.getStore();
};

export const getRunScope = (): CiRunScope | undefined => {
  return getStore()?.run;
};
export const getJobScope = (): CiJobScope | undefined => {
  return getStore()?.job;
};

/**
 * Count a call to a public API in the current run, for run metadata. Outside a
 * run there's nothing to count into.
 */
export const countApi = (api: ApiName): void => {
  const run = getRunScope();

  if (run) {
    run.apis[api] += 1;
  }
};

/**
 * Note how long a slow step took, in the run's timings and its debug log.
 */
export const recordTiming = (run: CiRunScope, timing: StepTiming): void => {
  run.timings.push(timing);

  run.logger?.debug?.({ timing }, `${timing.kind} took ${timing.durationMs}ms`);
};

export const runInScope = <R>(store: CiStore, fn: () => R): R => {
  return (resolvedAls ?? fallbackAls).run(store, fn);
};

/**
 * Return the current job scope, or throw a message explaining what to do.
 */
export const requireJobScope = (api: string): CiJobScope => {
  const job = getJobScope();

  if (!job) {
    if (getRunScope()) {
      throw new CiUsageError(
        `\`${api}\` was called outside a job, so there's no machine to run it on. Wrap it in \`ci.job()\`.`,
      );
    }

    throw new CiUsageError(
      `\`${api}\` was called outside a pipeline run. Call it from a job inside \`ci.pipeline()\`.`,
    );
  }

  return job;
};

export const requireRunScope = (api: string): CiRunScope => {
  const run = getRunScope();

  if (!run) {
    throw new CiUsageError(
      `\`${api}\` was called outside a pipeline run. Call it from inside \`ci.pipeline()\`.`,
    );
  }

  return run;
};

/**
 * Build a step ID for a scope, adding ` #n` from the second use of the same
 * label onwards. This is deterministic because handler code is.
 */
export const nextStepId = (
  run: CiRunScope,
  scopePath: string | undefined,
  label: string,
): string => {
  const base = scopePath ? `${scopePath}${scopeSeparator}${label}` : label;
  const seen = (run.counters.get(base) ?? 0) + 1;

  run.counters.set(base, seen);

  return seen === 1 ? base : `${base} #${seen}`;
};

/**
 * Wrap step tools so every ID they're given is prefixed with a scope path, and
 * so the CI scope is still there inside the handler.
 *
 * User code inside a job writes `step.run("create-db", …)`, and the ID that
 * reaches the executor is `test › create-db`, so two jobs can use the same
 * name.
 *
 * The scope part matters because the execution engine calls step handlers from
 * its own context rather than the caller's, so without this a `github.rest`
 * call inside `step.run` couldn't tell which run it belonged to.
 */
export const withStepIdPrefix = <T extends object>(
  tools: T,
  prefix?: string,
): T => {
  const cache = new Map<string | symbol, unknown>();

  return new Proxy(tools, {
    get(target, prop, receiver) {
      if (cache.has(prop)) {
        return cache.get(prop);
      }

      const value = Reflect.get(target, prop, receiver) as unknown;

      if (typeof value === "function") {
        const wrapped = (...args: unknown[]) => {
          const [idOrOptions, ...rest] = args;
          const store = getStore();

          return (value as (...a: unknown[]) => unknown).apply(target, [
            prefix === undefined
              ? idOrOptions
              : prefixStepId(idOrOptions, prefix),
            ...rest.map((arg) => {
              return typeof arg === "function"
                ? inScope(store, arg as (...args: unknown[]) => unknown)
                : arg;
            }),
          ]);
        };

        cache.set(prop, wrapped);

        return wrapped;
      }

      if (value && typeof value === "object") {
        const wrapped = withStepIdPrefix(value as object, prefix);

        cache.set(prop, wrapped);

        return wrapped;
      }

      return value;
    },
  });
};

/**
 * Re-enter a scope for a callback the engine will run later, from its own
 * context.
 */
const inScope = (
  store: CiStore | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: any step handler
  fn: (...args: any[]) => unknown,
  // biome-ignore lint/suspicious/noExplicitAny: any step handler
): ((...args: any[]) => unknown) => {
  return store
    ? (...args) => {
        return runInScope(store, () => {
          return fn(...args);
        });
      }
    : fn;
};

/**
 * Step tools that keep the CI scope alive inside their handlers, without
 * touching IDs. CI's own steps write their IDs out in full.
 */
export const withScopePreserved = <T extends object>(tools: T): T => {
  return withStepIdPrefix(tools);
};

/**
 * Prefix a step's ID with its scope path, and name it by the ID it was given,
 * since its job's span already shows the rest.
 */
const prefixStepId = (idOrOptions: unknown, prefix: string): unknown => {
  if (typeof idOrOptions === "string") {
    return {
      id: `${prefix}${scopeSeparator}${idOrOptions}`,
      name: idOrOptions,
    };
  }

  if (
    idOrOptions &&
    typeof idOrOptions === "object" &&
    "id" in idOrOptions &&
    typeof (idOrOptions as { id: unknown }).id === "string"
  ) {
    const opts = idOrOptions as { id: string; name?: string };

    return {
      ...opts,
      id: `${prefix}${scopeSeparator}${opts.id}`,
      name: opts.name ?? opts.id,
    };
  }

  return idOrOptions;
};

/**
 * Run `fn` in a job's trace span. The span is top-level wherever the job is
 * started from, so work on its machine that another job asks for later, like
 * a snapshot, comes back to it.
 */
export const inJobSpan = <R>(
  run: CiRunScope,
  jobPath: string,
  fn: () => R,
): R => {
  return runWithAsyncCtx(run.asyncCtx, () => {
    return inSpan(
      { id: jobPath, name: traceName.job(run, jobPath), kind: "job" },
      fn,
    );
  });
};

/**
 * Run `fn` in the run's one top-level GitHub span, wherever it's called from.
 * Reporting isn't a job's own work, so a job's span ends with the job, and a
 * failed job doesn't end on a green check update.
 */
export const inGitHubSpan = <R>(run: CiRunScope, fn: () => R): R => {
  return runWithAsyncCtx(run.asyncCtx, () => {
    return inSpan(ciSpan("github", traceName.github), fn);
  });
};

/**
 * Run a job handler inside both the CI job scope and a copy of the SDK's async
 * context whose `step` prefixes IDs with the job path. It copies the context
 * `inJobSpan` set, so the handler's steps are in the job's span.
 */
export const runJobBody = async <R>(
  scope: CiJobScope,
  fn: () => Promise<R>,
): Promise<R> => {
  const asyncCtx = await getAsyncCtx();

  if (!asyncCtx?.execution) {
    return runInScope({ run: scope.run, job: scope }, fn);
  }

  const scopedCtx: AsyncContext = {
    ...asyncCtx,
    execution: {
      ...asyncCtx.execution,
      ctx: {
        ...asyncCtx.execution.ctx,
        step: withStepIdPrefix(asyncCtx.execution.ctx.step, scope.path),
      },
    },
  };

  return runWithAsyncCtx(scopedCtx, () => {
    return runInScope({ run: scope.run, job: scope }, fn);
  });
};
