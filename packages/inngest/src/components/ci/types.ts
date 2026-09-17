import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { InngestFunction } from "../InngestFunction.ts";

/**
 * A duration, expressed as a time string like `"10m"`, `"24h"`, or `"1h30m"`.
 */
export type Duration = string;

/**
 * A trigger for a pipeline. This is an Inngest function trigger, so
 * `{ cron: "0 3 * * *" }` and `{ event, if }` both work, plus a phantom type
 * carrying the event data the trigger produces.
 *
 * `TData` never exists at runtime. It's what lets a handler know that
 * `github.pullRequest()` means `event.data.pull_request` is there:
 *
 * ```ts
 * ci.pipeline({ id: "pr", on: github.pullRequest() }, async ({ event }) => {
 *   event.data.pull_request.head.sha; // string
 * });
 * ```
 */
export type CiTrigger<TData = unknown> = InngestFunction.Trigger<string> & {
  /**
   * The shape of `event.data` for this trigger. Phantom: it is never present
   * at runtime, and never needs to be given.
   *
   * @internal
   */
  readonly __ciEventData?: TData;
};

/**
 * What `ci.pipeline({ on })` accepts: one trigger, or any nesting of arrays of
 * them, so `on: [github.pullRequest(), github.push()]` works.
 */
export type CiTriggerInput =
  // biome-ignore lint/suspicious/noExplicitAny: matches a trigger of any payload
  | CiTrigger<any>
  // biome-ignore lint/suspicious/noExplicitAny: matches a trigger of any payload
  | readonly (CiTrigger<any> | readonly CiTrigger<any>[])[];

/**
 * The event data a set of triggers produces, or `never` when none of them say.
 */
type PayloadOf<TTriggers> = TTriggers extends readonly (infer TTrigger)[]
  ? PayloadOf<TTrigger>
  : TTriggers extends { readonly __ciEventData?: infer TData }
    ? // A trigger written by hand, like `{ cron }`, has no phantom, and infers
      // `unknown`; that shouldn't swallow the payloads beside it in a union.
      unknown extends TData
      ? never
      : TData
    : never;

/**
 * `event.data` for a pipeline's handler: what its triggers say, or an open
 * record when they don't say anything, as with a cron.
 */
export type EventDataOf<TTriggers> = [PayloadOf<TTriggers>] extends [never]
  ? Record<string, unknown>
  : PayloadOf<TTriggers>;

/**
 * An event as a pipeline handler sees it.
 */
export interface CiEvent<TData = Record<string, unknown>> {
  /** The event's name, like `github/pull_request.opened`. */
  name: string;
  /** The event's payload, typed by the pipeline's triggers. */
  data: TData;
  id?: string;
  ts?: number;
  v?: string;
}

/**
 * The subset of `createFunction` options a pipeline passes through. These are
 * taken from the existing function options rather than copied, so they stay in
 * step with the SDK.
 */
export type FlowControlOptions = Pick<
  InngestFunction.Options,
  | "concurrency"
  | "throttle"
  | "rateLimit"
  | "debounce"
  | "priority"
  | "singleton"
  | "idempotency"
  | "batchEvents"
  | "timeouts"
  | "cancelOn"
  | "retries"
  | "name"
  | "description"
>;

/**
 * Machine settings for a job.
 */
export interface MachineConfig {
  /**
   * The number of vCPUs the machine gets. Memory is paired with this: 1 vCPU
   * gets 1 GiB, 2 gets 2 GiB, and 4 gets 4 GiB. Defaults to 2.
   */
  vcpu?: 1 | 2 | 4;

  /**
   * @deprecated Not yet supported by Inngest Sandboxes: custom images aren't
   * exposed. This is ignored with a warning.
   */
  image?: string;

  /**
   * @deprecated Not yet supported by Inngest Sandboxes: architecture selection
   * isn't exposed. This is ignored with a warning.
   */
  arch?: "amd64" | "arm64";
}

/**
 * Where a pipeline run came from, derived from the trigger event.
 */
export interface RepoContext {
  owner: string;
  name: string;
  fullName: string;
  /** The PR head sha, push after sha, or merge group head sha. */
  sha: string;
  ref?: string;
  baseSha?: string;
  baseRef?: string;
  pullRequest?: { number: number; headRef: string; fork: boolean };
  installationId?: number;
  /** Set by local fixtures, so `checkout()` can use the working tree. */
  local?: { path: string; baseRef: string };
  /** The name of the event that triggered the run, for check summaries. */
  trigger?: string;
}

/**
 * A part of a cache key that's resolved at runtime, like `files()`.
 */
export interface CacheKeyPart {
  readonly kind: "inngest/ci.cacheKeyPart";
  readonly type: "files";
  readonly patterns: string[];
}

export type CacheKey =
  | CacheKeyPart
  | string
  | (CacheKeyPart | string)[]
  | (() => Promise<string>);

export interface CacheConfig {
  /**
   * What the job depends on. If nothing in the key changed since the last
   * successful run, the job is reused.
   *
   * "Cache" reads a little oddly for jobs like `test` that don't restore
   * anything; the trace and checks say "restored" or "passed at …" instead.
   */
  key?: CacheKey;

  /**
   * Triggers that rebuild the cache ahead of time, like a nightly cron, so
   * pull requests don't pay for it.
   */
  refresh?: CiTrigger[];

  /**
   * Defaults to `"branch"`: PRs read from the default branch and write to
   * their own scope.
   */
  scope?: "branch" | "global";
}

export interface CacheEntry {
  key: string;
  jobId: string;
  snapshotId?: string;
  result: unknown;
  builtAt: string;
  builtBy: { runId: string; sha?: string; trigger: string };
  /** Parent jobs this job started `from()` when it last ran. */
  fromJobIds?: string[];
}

/**
 * Where cache entries live. Implement this to keep them anywhere you like.
 *
 * ```ts
 * const redisCacheStore = (redis: Redis): CacheStore => ({
 *   get: async (key) => JSON.parse((await redis.get(key)) ?? "null") ?? undefined,
 *   set: async (key, entry) => void redis.set(key, JSON.stringify(entry)),
 * });
 * ```
 */
export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

/**
 * A job's options, for when an ID on its own isn't enough.
 *
 * `TInput` is inferred from the handler, so a job that takes an input is
 * written without any generics:
 *
 * ```ts
 * const compat = ci.job("compat", async (node: string) => {
 *   await $`fnm use ${node}`;
 * });
 * ```
 */
export interface JobConfig<_TInput = void> {
  /** Unique within the CI client. It's the job's path in the trace and its check name. */
  id: string;
  /** Machine settings for this job, overriding the pipeline's and the client's. */
  machine?: MachineConfig;
  /**
   * Reuse the job's last result when nothing it depends on has changed.
   *
   * "Cache" reads oddly for a job like `test`, where nothing is restored and
   * the job simply doesn't need to run again. The trace and checks say what
   * actually happened: "restored" or "passed at …".
   */
  cache?: CacheConfig;
  /** Check settings for this job. `false` means no job check. */
  check?: false | { name?: string };
  /**
   * Snapshot the machine if the job fails, so you can start from where it
   * broke. The snapshot ID is on the job's check and in the run's summary.
   */
  keepOnFailure?: Duration;
}

/**
 * A job: call it like a function.
 *
 * Calling it twice in one run joins the run already in progress, so two parts
 * of a pipeline can both depend on it without it running twice.
 */
export interface Job<TResult = unknown, TInput = void> {
  (input: TInput): Promise<TResult>;
  /** The job's ID, as given to `ci.job()`. */
  readonly id: string;
  readonly kind: "inngest/ci.job";
}

/**
 * Any job, regardless of its input and result types.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches any job
export type AnyJob = Job<any, any>;

/**
 * A pipeline's options. Every flow control option `createFunction` takes works
 * here too, so `singleton`, `idempotency`, `concurrency`, `throttle`,
 * `debounce`, `rateLimit`, `priority`, `batchEvents`, `timeouts`, `cancelOn`,
 * and `retries` are all available.
 *
 * ```ts
 * ci.pipeline(
 *   {
 *     id: "pr",
 *     on: github.pullRequest(),
 *     // a new push to the same pull request cancels the run in progress
 *     singleton: { key: "event.data.pull_request.number", mode: "cancel" },
 *   },
 *   async () => { … },
 * );
 * ```
 */
export interface PipelineConfig<
  TTriggers extends CiTriggerInput = CiTriggerInput,
> extends FlowControlOptions {
  /** Unique within the app. It names the function, the run, and the check. */
  id: string;
  /** What starts this pipeline. Pass an array for several triggers. */
  on: TTriggers;
  /**
   * Check settings. `false` turns off all checks for this pipeline, and
   * `{ jobs: false }` keeps the pipeline check but drops the per-job ones.
   */
  check?: false | { name?: string; jobs?: boolean };
  /** Default machine for this pipeline's jobs. */
  machine?: MachineConfig;
  /**
   * For triggers with no repo of their own, like crons, the `owner/repo` to
   * resolve a head commit from.
   */
  repo?: string;
  /**
   * Set from a `github.comment({ minPermission })` trigger. CEL can't ask
   * GitHub whether someone is allowed, so the run checks it and reports
   * "Not permitted" instead.
   *
   * @internal
   */
  commentPermission?: "read" | "triage" | "write" | "maintain" | "admin";
}

/**
 * What a pipeline handler is given.
 *
 * `event` is typed by the pipeline's triggers, so a pipeline on
 * `github.pullRequest()` can read `event.data.pull_request` without a cast.
 */
export interface PipelineContext<
  TTriggers extends CiTriggerInput = CiTriggerInput,
> {
  /** The event that started this run. */
  event: CiEvent<EventDataOf<TTriggers>>;
  /** Every event in the batch, when `batchEvents` is on. Otherwise just the one. */
  events: CiEvent<EventDataOf<TTriggers>>[];
  /** This run's ID, as it appears in the trace. */
  runId: string;
  /** The pipeline's ID, as given to `ci.pipeline()`. */
  pipelineId: string;
  /**
   * The repository this run is for, derived from the trigger. `undefined` for
   * triggers that don't carry one, like a cron with no `repo` set.
   */
  repo: RepoContext | undefined;
  /** Which attempt of this run this is, counting from 0. */
  attempt: number;
  /** The run's logger, which writes into the trace. */
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
  };
}

/**
 * Returned from a pipeline handler to end the run early with a reason shown on
 * the check.
 */
export interface CiSkip {
  readonly kind: "inngest/ci.skip";
  readonly reason: string;
}

/**
 * What a finished command gives you.
 */
export interface CommandResult {
  /** Zero unless something went wrong. A non-zero code throws unless `.nothrow()`. */
  exitCode: number;
  /** The last 64 KiB of stdout, with any `withSecret` values masked. */
  stdout: string;
  /** The last 64 KiB of stderr, with any `withSecret` values masked. */
  stderr: string;
  /** Whether output was cut to fit. The whole of it is on the machine. */
  truncated: boolean;
  /** How long the command took, as far as the machine could tell. */
  durationMs: number;
}

/**
 * A command started with `.background()`, still running.
 */
export interface BackgroundProcess {
  /** The process ID on the machine. */
  readonly id: string;
  /** Wait for it to exit, and read its result. */
  exited(): Promise<CommandResult>;
  /** Signal it. Defaults to 15 (`SIGTERM`). */
  kill(signal?: number): Promise<void>;
  /** Read what it has printed so far. */
  output(opts?: { tailBytes?: number }): Promise<string>;
}

/**
 * What can be interpolated into a command.
 *
 * Each value becomes one argument, arrays spread into several, and `null`,
 * `undefined`, and `false` are dropped — so `${cond && ["--flag", x]}` works.
 */
export type CommandValue =
  | string
  | number
  | boolean
  | readonly (string | number)[]
  | null
  | undefined;

/**
 * A command, lazy until it's awaited.
 *
 * Every option returns the command, so they chain:
 *
 * ```ts
 * await $`pnpm test`.env({ CI: "true" }).retries(1).timeout("10m");
 * ```
 */
export interface Command extends PromiseLike<CommandResult> {
  /** Environment variables for this command, over the job's defaults. */
  env(vars: Record<string, string>): Command;
  /** Where to run, on the machine. Defaults to `/work` after `checkout()`. */
  cwd(path: string): Command;
  /**
   * Give the command a readable label, which becomes its step name.
   *
   * ```ts
   * await $`pnpm exec playwright test --project=chromium`.as("e2e: chromium");
   * ```
   */
  as(name: string): Command;
  /**
   * Run it again if it fails, up to `count` more times.
   *
   * Each attempt is its own step, so the check and the trace show which
   * attempt this is and why the last one failed. Retries land on the same
   * machine.
   */
  retries(count: number): Command;
  /**
   * Return the result with its non-zero exit code instead of throwing, for
   * when a failure is information rather than an error.
   *
   * ```ts
   * const { exitCode } = await $`pnpm lint`.nothrow();
   * ```
   */
  nothrow(): Command;
  /**
   * Give up after this long, and throw `CommandTimeoutError`.
   *
   * A timeout under five minutes also makes the command a single captured
   * step, which is cheaper and keeps the trace tidy.
   */
  timeout(duration: Duration): Command;
  /**
   * Run this before the command is killed by its timeout, for a last look at
   * what it was doing.
   *
   * ```ts
   * await $`pnpm test`.timeout("10m").onTimeout(() => $`ps auxf`);
   * ```
   */
  onTimeout(fn: () => Promise<unknown>): Command;
  /**
   * Start the command and keep it running while the job continues.
   *
   * ```ts
   * const server = await $`pnpm start`.background();
   * await waitForPort(3000);
   * // …
   * await server.kill();
   * ```
   *
   * Note: there are no process exit events yet, so `exited()` polls rather
   * than waiting on one.
   */
  background(): Promise<BackgroundProcess>;
  /**
   * @deprecated Not yet supported by Inngest Sandboxes: there's no secret
   * injection, so the value is passed as an environment variable from inside
   * the step handler and masked in output. It isn't isolated from code running
   * on the machine.
   */
  withSecret(name: string, value: string): Command;
  /** Run it and return stdout, trimmed. */
  text(): Promise<string>;
  /** Run it and return stdout's lines, with no trailing blank. */
  lines(): Promise<string[]>;
  /** Run it and parse stdout as JSON. */
  json<T = unknown>(): Promise<T>;
}

/**
 * The `$` tag itself: a template tag that builds a {@link Command}.
 */
export type CommandTag = (
  strings: TemplateStringsArray,
  ...values: CommandValue[]
) => Command;

export interface ExtraMachine {
  readonly name: string;
  $: CommandTag & { sh: CommandTag };
  waitForPort(port: number, opts?: { timeout?: Duration }): Promise<void>;
  waitForHttp(
    url: string,
    opts?: { timeout?: Duration; status?: number },
  ): Promise<void>;
  /**
   * @deprecated Not yet supported by Inngest Sandboxes: machines can't reach
   * each other. Throws `CiNotSupportedError`.
   */
  url(port: number): string;
}

/**
 * The axes a matrix runs over: a name, and the values to try.
 */
export type MatrixAxes = Record<string, readonly unknown[]>;

/**
 * One combination of a matrix's axes.
 *
 * Values keep their literal types, so a handler's `combo.node` is
 * `"20" | "22"` rather than `string`, and a typo in `exclude` is a type error.
 */
export type MatrixCombo<TAxes> = {
  [K in keyof TAxes]: TAxes[K] extends readonly (infer TValue)[]
    ? TValue
    : never;
};

/**
 * A matrix's options.
 *
 * ```ts
 * const compat = ci.matrix(
 *   {
 *     id: "compat",
 *     axes: { node: ["20", "22", "24"], db: ["sqlite", "postgres"] },
 *     exclude: [{ node: "20", db: "postgres" }],
 *     concurrency: 3,
 *   },
 *   async ({ node, db }) => {
 *     await $`pnpm test`.env({ NODE_VERSION: node, TEST_DATABASE: db });
 *   },
 * );
 * ```
 */
export interface MatrixConfig<TAxes extends MatrixAxes = MatrixAxes> {
  /** Unique within the CI client. Each combination's job ID starts with it. */
  id: string;
  /** The axes to combine, in the order they should appear in job IDs. */
  axes: TAxes;
  /** Combinations to leave out. A partial combination excludes every match. */
  exclude?: readonly Partial<MatrixCombo<TAxes>>[];
  /** Extra combinations to add, beyond the product of the axes. */
  include?: readonly MatrixCombo<TAxes>[];
  /** How many combinations may run at once. Defaults to all of them. */
  concurrency?: number;
  /**
   * Stop the rest when one fails. Off by default, so one bad combination
   * doesn't hide the others' results.
   */
  failFast?: boolean;
  /** Machine settings, per combination if you need them to differ. */
  machine?: MachineConfig | ((combo: MatrixCombo<TAxes>) => MachineConfig);
  /** Cache settings, per combination if you need them to differ. */
  cache?: CacheConfig | ((combo: MatrixCombo<TAxes>) => CacheConfig);
  /** Check settings for each combination's job. `false` means no job checks. */
  check?: false | { name?: string };
}

/**
 * A matrix: call it to run every combination, or pass part of a combination to
 * run only what matches.
 *
 * ```ts
 * await compat();                               // every combination
 * await compat({ node: "22" });                 // just the Node 22 ones
 * await compat({ node: "22", db: "postgres" }); // just the one
 * ```
 */
export interface Matrix<TAxes extends MatrixAxes, TResult> {
  (only?: Partial<MatrixCombo<TAxes>>): Promise<TResult[]>;
  /** The matrix's ID, as given to `ci.matrix()`. */
  readonly id: string;
}

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "skipped"
  | "stale";

export interface CheckAnnotation {
  path: string;
  /** Shorthand for `start_line` and `end_line`. */
  line?: number;
  start_line?: number;
  end_line?: number;
  annotation_level?: "notice" | "warning" | "failure";
  message: string;
  title?: string;
  raw_details?: string;
}

export interface ManualTriggerOptions<TSchema extends StandardSchemaV1> {
  schema: TSchema;
}
