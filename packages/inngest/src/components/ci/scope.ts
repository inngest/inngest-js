import type { AsyncContext } from "../execution/als.ts";
import { runWithAsyncCtx } from "../execution/als.ts";
import type { GenericStepTools } from "../InngestStepTools.ts";
import type { DurableSandboxTools } from "../sandbox/types.ts";
import { CiUsageError } from "./errors.ts";
import type {
  CacheEntry,
  CheckAnnotation,
  CheckConclusion,
  JobConfig,
  RepoContext,
} from "./types.ts";

/**
 * The separator used between parts of a scope path and a step label. It's a
 * single character that never appears in job IDs in practice, so paths stay
 * readable in the trace.
 */
export const scopeSeparator = " › ";

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
  // biome-ignore lint/suspicious/noExplicitAny: CacheStore
  cacheStore: any;
  defaultMachine?: { vcpu?: 1 | 2 | 4 };
  runUrl: (ctx: { runId: string; functionId: string }) => string;
  // biome-ignore lint/suspicious/noExplicitAny: Inngest.Any
  client: any;
  isDev: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: any logger-ish
  logger?: { warn: (...args: any[]) => void };
}

export interface CiRunScope {
  ci: CiInternals;
  runId: string;
  functionId: string;
  pipelineId: string;
  /** The pipeline check's name. `undefined` when checks are off. */
  checkName?: string;
  jobChecks: boolean;
  event: unknown;
  repo?: RepoContext;
  /** Jobs that have started in this run, keyed by job ID. */
  jobs: Map<string, Promise<unknown>>;
  /** Machines created in this run, keyed by scope path. */
  machines: Map<string, Promise<MachineHandle>>;
  /** Snapshots taken of finished jobs, keyed by job path. */
  snapshots: Map<string, Promise<string | undefined>>;
  /** Cache entries resolved this run, keyed by job path. */
  cacheEntries: Map<string, CacheEntry | undefined>;
  /** Sandbox IDs created in this run, for cleanup. */
  sandboxes: Set<string>;
  /** Job results in call order, for the pipeline check summary. */
  summaries: JobSummary[];
  /**
   * Job checks that have started and not finished. When a run ends while jobs
   * are still going, these are completed rather than left spinning.
   */
  openChecks: Map<string, string | undefined>;
  /** Raw step tools for CI's own steps. IDs are written in full. */
  step: GenericStepTools;
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
  fromCalled: boolean;
  fromJobIds: string[];
  annotations: CheckAnnotation[];
  /** Extra summary markdown added with `report.summary`. */
  summaries: string[];
  /** Set once the job check has been created. */
  checkStarted: boolean;
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
  getStore: () => undefined,
  run: (_store, fn) => fn(),
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

const getStore = (): CiStore | undefined => resolvedAls?.getStore();

export const getRunScope = (): CiRunScope | undefined => getStore()?.run;
export const getJobScope = (): CiJobScope | undefined => getStore()?.job;

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
            ...rest.map((arg) =>
              typeof arg === "function"
                ? inScope(store, arg as (...args: unknown[]) => unknown)
                : arg,
            ),
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
): ((...args: any[]) => unknown) =>
  store ? (...args) => runInScope(store, () => fn(...args)) : fn;

/**
 * Step tools that keep the CI scope alive inside their handlers, without
 * touching IDs. CI's own steps write their IDs out in full.
 */
export const withScopePreserved = <T extends object>(tools: T): T =>
  withStepIdPrefix(tools);

const prefixStepId = (idOrOptions: unknown, prefix: string): unknown => {
  if (typeof idOrOptions === "string") {
    return `${prefix}${scopeSeparator}${idOrOptions}`;
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
 * Run a job handler inside both the CI job scope and a copy of the SDK's async
 * context whose `step` prefixes IDs with the job path.
 */
export const runJobBody = async <R>(
  scope: CiJobScope,
  fn: () => Promise<R>,
): Promise<R> => {
  const { asyncCtx } = scope.run;

  if (!asyncCtx.execution) {
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

  return runWithAsyncCtx(scopedCtx, () =>
    runInScope({ run: scope.run, job: scope }, fn),
  );
};
