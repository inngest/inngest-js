/**
 * EXPERIMENTAL: `@inngest/ci` is an early prototype. Everything exported here
 * may change without a major version bump.
 *
 * Write CI in TypeScript. A pipeline runs when something happens and calls
 * your jobs; each job gets its own machine when it runs its first command.
 *
 * ```ts
 * import { createCi, github, checkout, $ } from "@inngest/ci";
 *
 * export const ci = createCi(inngest);
 *
 * const test = ci.job("test", async () => {
 *   await checkout();
 *   await $`pnpm install`;
 *   await $`pnpm test`;
 * });
 *
 * export const pr = ci.pipeline(
 *   { id: "pr", on: github.pullRequest() },
 *   async () => {
 *     await test();
 *   },
 * );
 * ```
 *
 * @module
 */

// Cache
export {
  fileCacheStore,
  inngestCacheStore,
  memoryCacheStore,
} from "./cache.ts";
// Commands
export { $ } from "./command.ts";
// Client
export type { Ci, CiOptions } from "./createCi.ts";
export { createCi } from "./createCi.ts";
// Errors
export {
  CiNotSupportedError,
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "./errors.ts";
// Extra machines
export { sandbox } from "./extraMachine.ts";
// GitHub
export type {
  ConsoleProvider,
  GitHubAppProvider,
  GitHubProvider,
  GitHubTokenProvider,
} from "./github/auth.ts";
export {
  consoleReporter,
  githubApp,
  githubToken,
} from "./github/auth.ts";
export type { GitHubEventData } from "./github/events.ts";
export {
  githubEventName,
  githubWebhookTransform,
} from "./github/events.ts";
export { fixtures } from "./github/fixtures.ts";
export type {
  DurableListMethod,
  ItemOf,
  ParamsOf,
  RunRepo,
} from "./github/helpers.ts";
export { github } from "./github/index.ts";
export type { DurableGitHubRest } from "./github/rest.ts";
export type {
  DefaultPullRequestActions,
  Permission,
  PullRequestAction,
  PullRequestEventFor,
} from "./github/triggers.ts";
// Helpers
export {
  changed,
  checkout,
  files,
  waitForHttp,
  waitForPort,
} from "./helpers.ts";
// Machines
export { from } from "./machine.ts";
// Reporting
export { report } from "./report.ts";
// Types
export type {
  BackgroundProcess,
  CacheConfig,
  CacheEntry,
  CacheKey,
  CacheKeyPart,
  CacheStore,
  CheckAnnotation,
  CheckConclusion,
  CiEvent,
  CiSkip,
  CiTrigger,
  CiTriggerInput,
  Command,
  CommandResult,
  CommandTag,
  CommandValue,
  Duration,
  EventDataOf,
  ExtraMachine,
  FlowControlOptions,
  Job,
  JobConfig,
  MachineConfig,
  Matrix,
  MatrixAxes,
  MatrixCombo,
  MatrixConfig,
  PipelineConfig,
  PipelineContext,
  RepoContext,
} from "./types.ts";
// Platform gaps: typed, deprecated, and explicit about why
export type { ShardOptions } from "./unsupported.ts";
export { oidc, shard, shell, vercel } from "./unsupported.ts";
