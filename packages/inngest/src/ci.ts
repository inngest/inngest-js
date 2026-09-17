/**
 * EXPERIMENTAL: `inngest/ci` is an early prototype. Everything exported here
 * may change without a major version bump.
 *
 * Write CI in TypeScript. A pipeline runs when something happens and calls
 * your jobs; each job gets its own machine when it runs its first command.
 *
 * ```ts
 * import { createCi, github, checkout, $ } from "inngest/ci";
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
} from "./components/ci/cache.ts";
// Commands
export { $ } from "./components/ci/command.ts";
// Client
export type { Ci, CiOptions } from "./components/ci/createCi.ts";
export { createCi } from "./components/ci/createCi.ts";
// Errors
export {
  CiNotSupportedError,
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "./components/ci/errors.ts";
// Extra machines
export { sandbox } from "./components/ci/extraMachine.ts";
// GitHub
export type {
  ConsoleProvider,
  GitHubAppProvider,
  GitHubProvider,
  GitHubTokenProvider,
} from "./components/ci/github/auth.ts";
export {
  consoleReporter,
  githubApp,
  githubToken,
} from "./components/ci/github/auth.ts";
export type { GitHubEventData } from "./components/ci/github/events.ts";
export {
  githubEventName,
  githubWebhookTransform,
} from "./components/ci/github/events.ts";
export { fixtures } from "./components/ci/github/fixtures.ts";
export { github } from "./components/ci/github/index.ts";
export type { DurableGitHubRest } from "./components/ci/github/rest.ts";
export type {
  Permission,
  PullRequestAction,
} from "./components/ci/github/triggers.ts";
// Helpers
export {
  changed,
  checkout,
  files,
  waitForHttp,
  waitForPort,
} from "./components/ci/helpers.ts";
// Machines
export { from } from "./components/ci/machine.ts";
// Reporting
export { report } from "./components/ci/report.ts";
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
  CiSkip,
  CiTrigger,
  Command,
  CommandResult,
  CommandTag,
  Duration,
  ExtraMachine,
  Job,
  JobConfig,
  MachineConfig,
  Matrix,
  MatrixCombo,
  MatrixConfig,
  PipelineConfig,
  PipelineContext,
  RepoContext,
} from "./components/ci/types.ts";
// Platform gaps: typed, deprecated, and explicit about why
export type { ShardOptions } from "./components/ci/unsupported.ts";
export { oidc, shard, shell, vercel } from "./components/ci/unsupported.ts";
