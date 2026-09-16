import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { InngestFunction } from "../InngestFunction.ts";

/**
 * A duration, expressed as a time string like `"10m"` or `"24h"`.
 */
export type Duration = string;

/**
 * A trigger for a pipeline. This is the same shape as an Inngest function
 * trigger, so `{ cron: "0 3 * * *" }` and `{ event, if }` both work.
 */
export type CiTrigger = InngestFunction.Trigger<string>;

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

export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

export interface JobConfig<_TInput = void> {
  id: string;
  machine?: MachineConfig;
  cache?: CacheConfig;
  /** Check settings for this job. `false` means no job check. */
  check?: false | { name?: string };
  /** Keep a snapshot of the machine if the job fails. */
  keepOnFailure?: Duration;
}

export interface Job<TResult, TInput = void> {
  (input: TInput): Promise<TResult>;
  readonly id: string;
  readonly kind: "inngest/ci.job";
}

/**
 * Any job, regardless of its input and result types.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches any job
export type AnyJob = Job<any, any>;

export interface PipelineConfig<TTriggers = CiTrigger | CiTrigger[]>
  extends FlowControlOptions {
  id: string;
  on: TTriggers;
  /** Check settings. `false` turns off all checks for this pipeline. */
  check?: false | { name?: string; jobs?: boolean };
  /** Default machine for this pipeline's jobs. */
  machine?: MachineConfig;
  /**
   * For triggers with no repo of their own, like crons, the `owner/repo` to
   * resolve a head commit from.
   */
  repo?: string;
}

export interface PipelineContext {
  // biome-ignore lint/suspicious/noExplicitAny: user event shape is unknown
  event: any;
  runId: string;
  repo: RepoContext | undefined;
}

/**
 * Returned from a pipeline handler to end the run early with a reason shown on
 * the check.
 */
export interface CiSkip {
  readonly kind: "inngest/ci.skip";
  readonly reason: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface BackgroundProcess {
  readonly id: string;
  exited(): Promise<CommandResult>;
  kill(signal?: number): Promise<void>;
  output(opts?: { tailBytes?: number }): Promise<string>;
}

export type CommandValue =
  | string
  | number
  | boolean
  | readonly (string | number)[]
  | null
  | undefined;

export interface Command extends PromiseLike<CommandResult> {
  env(vars: Record<string, string>): Command;
  cwd(path: string): Command;
  /** Give the command a readable label, used for its step ID. */
  as(name: string): Command;
  retries(count: number): Command;
  /** Return the result with a non-zero exit code instead of throwing. */
  nothrow(): Command;
  timeout(duration: Duration): Command;
  onTimeout(fn: () => Promise<unknown>): Command;
  /**
   * Start the command and keep it running while the job continues.
   *
   * Note: there are no process exit events yet, so `exited()` polls with wait
   * steps rather than waiting on an event.
   */
  background(): Promise<BackgroundProcess>;
  /**
   * @deprecated Not yet supported by Inngest Sandboxes: there's no secret
   * injection, so the value is passed as an environment variable from inside
   * the step handler and masked in output. It isn't isolated from code running
   * on the machine.
   */
  withSecret(name: string, value: string): Command;
  text(): Promise<string>;
  lines(): Promise<string[]>;
  json<T = unknown>(): Promise<T>;
}

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

export type MatrixCombo<TAxes> = {
  [K in keyof TAxes]: TAxes[K] extends readonly (infer TValue)[]
    ? TValue
    : never;
};

export interface MatrixConfig<
  TAxes extends Record<string, readonly unknown[]> = Record<
    string,
    readonly unknown[]
  >,
> {
  id: string;
  axes: TAxes;
  exclude?: Partial<MatrixCombo<TAxes>>[];
  include?: MatrixCombo<TAxes>[];
  concurrency?: number;
  /** Stop the rest when one fails. Off by default, so you see every result. */
  failFast?: boolean;
  machine?: MachineConfig | ((combo: MatrixCombo<TAxes>) => MachineConfig);
  cache?: CacheConfig | ((combo: MatrixCombo<TAxes>) => CacheConfig);
  check?: false | { name?: string };
}

export interface Matrix<TAxes, TResult> {
  (only?: Partial<MatrixCombo<TAxes>>): Promise<TResult[]>;
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
