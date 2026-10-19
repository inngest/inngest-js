/**
 * Write CI in TypeScript. A pipeline runs when something happens and calls
 * your jobs; each job gets its own machine when it runs its first command.
 *
 * ```ts
 * import { $, checkout, createCi, github } from "@inngest/ci";
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
 * An Inngest Labs project (https://www.inngest.com/docs/labs): APIs may change
 * between 0.x releases.
 *
 * @module
 */

// Caching
export { files } from "./cache/cache.ts";
// Checkout, sharding and waiting
export { changed } from "./checkout/changed.ts";
export { checkout } from "./checkout/checkout.ts";
export type { ShardOptions } from "./checkout/shard.ts";
export { shard } from "./checkout/shard.ts";
export { waitForHttp, waitForPort } from "./checkout/wait.ts";
// Errors
export {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "./errors.ts";
// GitHub: triggers, REST client, auth and webhook wiring
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
// Commands and machines
export { $ } from "./machine/command.ts";
export { sandbox } from "./machine/sandbox.ts";
// Client and pipelines
export type { Ci, CiOptions } from "./pipeline/createCi.ts";
export { createCi } from "./pipeline/createCi.ts";
// Reporting
export { report } from "./report.ts";

// Types
export type {
  BackgroundProcess,
  CacheConfig,
  CacheKey,
  CacheKeyPart,
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
  FilesOptions,
  FlowControlOptions,
  From,
  Job,
  JobConfig,
  JobRef,
  MachineConfig,
  Matrix,
  MatrixAxes,
  MatrixCombo,
  MatrixConfig,
  PipelineConfig,
  PipelineContext,
  RepoContext,
} from "./types.ts";
