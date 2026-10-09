/**
 * The public types of `@inngest/ci`: configs, commands, caches, matrices and
 * the trigger shapes. These double as the user docs in editor hovers, so every
 * exported type says what it is for.
 *
 * @module
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InngestFunction } from "inngest";

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
  /** The event's ID, if it was sent with one. */
  id?: string;
  /** When the event happened, in milliseconds since the epoch. */
  ts?: number;
  /** The event's schema version, if it has one. */
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
}

/**
 * Where a pipeline run came from, derived from the trigger event.
 */
export interface RepoContext {
  /** The repository's owner, like `inngest`. */
  owner: string;
  /** The repository's name without the owner, like `inngest-js`. */
  name: string;
  /** The owner and name together, like `inngest/inngest-js`. */
  fullName: string;
  /** The PR head sha, push after sha, or merge group head sha. */
  sha: string;
  /** The branch or tag the run is for, like `refs/heads/main`. */
  ref?: string;
  /** The commit the change is based on, for diffs. */
  baseSha?: string;
  /** The branch the change is based on, like `main`. */
  baseRef?: string;
  /** Set for pull request runs. `fork` is true when the head is another repo. */
  pullRequest?: { number: number; headRef: string; fork: boolean };
  /** The GitHub App installation the event came from, if any. */
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

/**
 * What a job's cache is keyed on: a string, a `files()` part, a list of those
 * joined together, or a function that computes the key when the job runs.
 */
export type CacheKey =
  | CacheKeyPart
  | string
  | (CacheKeyPart | string)[]
  | (() => Promise<string>);

/**
 * A job's cache settings. `from` shares a job's machine within one run, and
 * only a `cache` key reuses it across runs.
 */
export interface CacheConfig {
  /**
   * What the job depends on. If nothing in the key changed since the last
   * successful run, the job is reused.
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

  /**
   * How old a cached snapshot may be before it is rebuilt, like `"1d"`. A
   * snapshot older than this, counted from when it was taken, is a miss: the
   * job builds again and the new snapshot takes the name.
   *
   * Without it a snapshot is reused until its key changes or it expires.
   */
  maxAge?: Duration;
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
export interface JobConfig<TInput = void> {
  /** Unique within the CI client. It's the job's check name, and its step IDs start with it. */
  id: string;
  /**
   * The job to start from: this job runs on a copy of that job's machine, so
   * it begins where the parent left off. The parent runs once however many
   * jobs start from it.
   *
   * ```ts
   * const install = ci.job("install", async () => {
   *   await checkout();
   *   await $`pnpm install`;
   * });
   *
   * const test = ci.job({ id: "test", from: install }, async () => {
   *   await $`pnpm test`;
   * });
   * ```
   *
   * A parent that takes input is given it with `job.with(input)`, and a
   * parent can depend on this job's own input by passing a function:
   *
   * ```ts
   * ci.job({ id: "web", from: build.with("web") }, …);
   * ci.job({ id: "test", from: ({ input }) => build.with(input) }, …);
   * ```
   *
   * To choose a parent from facts only known at run time, define two jobs and
   * choose between them in the pipeline.
   */
  from?: From<TInput>;
  /** What the trace calls the job. Defaults to `id`. */
  name?: string;
  /** Machine settings for this job, overriding the pipeline's and the client's. */
  machine?: MachineConfig;
  /**
   * Snapshot the job's machine when it passes, and reuse that snapshot while
   * nothing in the key has changed: the job doesn't run again, and jobs that
   * start `from` it start from the snapshot. A job that runs no commands has
   * no machine, so it isn't cached.
   */
  cache?: CacheConfig;
  /** Check settings for this job. `false` means no job check. */
  check?: false | { name?: string };
  /**
   * Snapshot the machine if the job fails, so you can start from where it
   * broke. The snapshot ID is in the pipeline check's summary, under "Kept
   * machines".
   *
   * The duration is currently ignored: the snapshot is kept for the
   * platform's default retention, whatever you pass.
   *
   * Every other snapshot a run takes for `from` is deleted when the run
   * ends, unless the job is cached. This one is kept.
   */
  keepOnFailure?: Duration;
  /**
   * The shape of the job's input, as any Standard Schema (Zod, Valibot,
   * ArkType, …). The handler gets the validated value.
   *
   * A cached job, and a job another starts `from`, is built in a run of its
   * own, which is sent the input you gave as JSON and validates it again. So
   * the input you give must survive JSON (no `Date`, `Map`, `Set` or
   * `bigint`), while the schema can turn it into any of those.
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
  input?: StandardSchemaV1;
}

/**
 * A job: call it like a function.
 *
 * Every call is its own run of the job, with its own machine, steps and check:
 * the second call in a pipeline run is `test (2)`. To share one run between
 * jobs, start them `from` it, which builds the parent once.
 *
 * A job is called for its side effects, so it resolves to nothing.
 */
export interface Job<TInput = void> {
  (input: TInput): Promise<void>;
  /** The job's ID, as given to `ci.job()`. */
  readonly id: string;
  readonly kind: "inngest/ci.job";
  /**
   * This job with an input, for another job to start `from`.
   *
   * ```ts
   * ci.job({ id: "web", from: build.with("web") }, …);
   * ```
   */
  with(input: TInput): JobRef<TInput>;
  /**
   * The job's input type, for type checks only: it's never set. It lets a
   * bare `from: job` accept only a job that runs without input.
   *
   * @internal
   */
  readonly "~input"?: (input: TInput) => void;
}

/**
 * A job with the input to run it with, from `job.with(input)`.
 */
export interface JobRef<TInput = unknown> {
  readonly kind: "inngest/ci.jobRef";
  readonly job: Job<TInput>;
  readonly input: TInput;
}

/**
 * Any job with input, regardless of its input type.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches any job's ref
export type AnyJobRef = JobRef<any>;

/**
 * A job as `from` takes it bare: one that runs without input. A job that
 * needs input is given it with `job.with(input)`. Without the call signature,
 * a function given to `from` is typed as the function of input it is.
 */
type JobLike = Pick<AnyJob, "id" | "kind" | "with"> & {
  readonly "~input"?: (input: undefined) => void;
};

/**
 * What a job can start `from`: a job, a job with input, or a function of the
 * starting job's own input that gives either.
 */
export type From<TInput = void> =
  | JobLike
  | AnyJobRef
  | ((ctx: {
      /** The starting job's input. */
      input: TInput;
    }) => JobLike | AnyJobRef);

/**
 * Any job, regardless of its input type.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches any job
export type AnyJob = Job<any>;

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
   * Set from `github.comment({ minPermission })` triggers, one per command.
   * CEL can't ask GitHub whether someone is allowed, so the run checks the
   * permission of the command that matched and reports "Not permitted"
   * instead.
   *
   * @internal
   */
  commentPermissions?: {
    command: string;
    minPermission: "read" | "triage" | "write" | "maintain" | "admin";
  }[];
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
  /** The last 64 KiB of stdout. */
  stdout: string;
  /** The last 64 KiB of stderr. */
  stderr: string;
  /** Whether output was cut to fit. The whole of it is on the machine. */
  truncated: boolean;
  /**
   * How long the command ran, from the machine's own timestamps. Missing when
   * the Sandbox API doesn't report them, which today is commands with a
   * timeout of 5 minutes or less.
   */
  durationMs?: number;
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
 * `undefined`, and `false` are dropped, so `${cond && ["--flag", x]}` works.
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
   * Not supported yet: running a command with a secret. The Sandbox API has
   * no per-command secrets, and values passed as command environment are
   * persisted in step data. Calling this throws `CiUsageError` and never sends
   * the value anywhere.
   *
   * @deprecated Don't use this until secrets are supported.
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

/**
 * A second machine for a job, like a database to test against. Commands run on
 * it, not on the job's own machine.
 */
export interface ExtraMachine {
  /** The name it was given, unique within the job. */
  readonly name: string;
  /** Run a command on this machine. `$.sh` runs a shell script. */
  $: CommandTag & { sh: CommandTag };
  /** Wait until something listens on `port`, or throw after `timeout`. */
  waitForPort(port: number, opts?: { timeout?: Duration }): Promise<void>;
  /** Wait until `url` answers (with `status`, if given), or throw after `timeout`. */
  waitForHttp(
    url: string,
    opts?: { timeout?: Duration; status?: number },
  ): Promise<void>;
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
   * doesn't hide the others' failures.
   */
  failFast?: boolean;
  /** Machine settings, per combination if you need them to differ. */
  machine?: MachineConfig | ((combo: MatrixCombo<TAxes>) => MachineConfig);
  /** Cache settings, per combination if you need them to differ. */
  cache?: CacheConfig | ((combo: MatrixCombo<TAxes>) => CacheConfig);
  /**
   * The job each combination starts `from`. A function is given the
   * combination as its `input`.
   */
  from?: From<MatrixCombo<TAxes>>;
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
export interface Matrix<TAxes extends MatrixAxes> {
  (only?: Partial<MatrixCombo<TAxes>>): Promise<void>;
  /** The matrix's ID, as given to `ci.matrix()`. */
  readonly id: string;
}

/**
 * How a check ended, as GitHub names it.
 */
export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "skipped"
  | "stale";

/**
 * A note on a line of a file, shown on the check and in the pull request diff.
 */
export interface CheckAnnotation {
  /** The file, relative to the repository root. */
  path: string;
  /** Shorthand for `start_line` and `end_line`. */
  line?: number;
  start_line?: number;
  end_line?: number;
  annotation_level?: "notice" | "warning" | "failure";
  /** What to say about the line. */
  message: string;
  /** A short heading for the annotation. */
  title?: string;
  /** Longer details, shown when the annotation is expanded. */
  raw_details?: string;
}
