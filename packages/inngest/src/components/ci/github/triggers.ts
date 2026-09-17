import type {
  CheckSuiteCompletedEvent,
  IssueCommentCreatedEvent,
  MergeGroupChecksRequestedEvent,
  PullRequestEvent,
  PushEvent,
} from "@octokit/webhooks-types";

import type { CiTrigger } from "../types.ts";
import type { GitHubEventData } from "./events.ts";

/**
 * The pull request actions a pipeline can trigger on.
 *
 * Whichever you pick types the handler's event: `types: ["closed"]` gives an
 * event with `pull_request.merged`, and the default three don't.
 */
export type PullRequestAction =
  | "opened"
  | "synchronize"
  | "reopened"
  | "ready_for_review"
  | "closed"
  | "labeled"
  | "unlabeled"
  | "edited";

/** The pull request actions a pipeline triggers on when it doesn't say. */
export type DefaultPullRequestActions = "opened" | "synchronize" | "reopened";

/**
 * The pull request event for a set of actions, as the handler sees it.
 */
export type PullRequestEventFor<TAction extends PullRequestAction> =
  GitHubEventData<Extract<PullRequestEvent, { action: TAction }>>;

/**
 * A permission level on a repository, from least to most.
 */
export type Permission = "read" | "triage" | "write" | "maintain" | "admin";

/**
 * The order permissions escalate in, used by `github.canUser()` and the
 * `minPermission` check on comment triggers.
 */
export const permissionOrder: Permission[] = [
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
];

export const hasPermission = (
  actual: string | undefined,
  required: Permission,
): boolean => {
  // GitHub reports "admin", "write", "read", and "none" for the permission
  // level, plus "triage" and "maintain" on some plans.
  const actualIndex = permissionOrder.indexOf(actual as Permission);
  if (actualIndex === -1) {
    return false;
  }
  return actualIndex >= permissionOrder.indexOf(required);
};

const repoCondition = (repo: string | undefined): string | undefined =>
  repo ? `event.data.repository.full_name == "${repo}"` : undefined;

const joinConditions = (
  conditions: Array<string | undefined>,
): string | undefined => {
  const parts = conditions.filter(Boolean) as string[];
  if (parts.length === 0) {
    return undefined;
  }
  return parts.map((part) => `(${part})`).join(" && ");
};

const anyOf = (expressions: string[]): string | undefined =>
  expressions.length === 0 ? undefined : expressions.join(" || ");

const trigger = <TData>(event: string, condition?: string): CiTrigger<TData> =>
  condition ? { event, if: condition } : { event };

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Run when a pull request opens, is pushed to, or reopens.
 *
 * One trigger per action, so the `if` expression stays readable, and the
 * handler's `event.data` is typed for exactly the actions asked for.
 *
 * ```ts
 * ci.pipeline(
 *   { id: "pr", on: github.pullRequest({ branches: ["main"] }) },
 *   async ({ event }) => {
 *     event.data.pull_request.head.sha; // string
 *   },
 * );
 * ```
 *
 * @param opts.branches - Only run for pull requests targeting these branches.
 * @param opts.types - Which pull request actions to run for. Defaults to
 * `opened`, `synchronize`, and `reopened`.
 * @param opts.repo - Only run for this `owner/name`, for pipelines watching
 * another repository.
 */
export const pullRequest = <
  const TTypes extends readonly PullRequestAction[] = readonly [
    "opened",
    "synchronize",
    "reopened",
  ],
>(
  opts: { branches?: string[]; types?: TTypes; repo?: string } = {},
): CiTrigger<PullRequestEventFor<TTypes[number]>>[] => {
  const types: readonly PullRequestAction[] = opts.types ?? [
    "opened",
    "synchronize",
    "reopened",
  ];

  const branchCondition = anyOf(
    (opts.branches ?? []).map(
      (branch) => `event.data.pull_request.base.ref == "${branch}"`,
    ),
  );

  const condition = joinConditions([branchCondition, repoCondition(opts.repo)]);

  return types.map((type) =>
    trigger<PullRequestEventFor<TTypes[number]>>(
      `github/pull_request.${type}`,
      condition,
    ),
  );
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Run when commits are pushed.
 *
 * Deleted-branch pushes are excluded, because there's nothing to check out.
 *
 * ```ts
 * ci.pipeline(
 *   { id: "release", on: github.push({ branches: ["main"], tags: ["v*"] }) },
 *   async ({ event }) => {
 *     event.data.after; // the commit that was pushed
 *   },
 * );
 * ```
 *
 * @param opts.branches - Branch names to run for. Omit for every branch.
 * @param opts.tags - Tag patterns to run for, like `v*`.
 * @param opts.repo - Only run for this `owner/name`.
 */
export const push = (
  opts: { branches?: string[]; tags?: string[]; repo?: string } = {},
): CiTrigger<GitHubEventData<PushEvent>>[] => {
  const refs = [
    ...(opts.branches ?? []).map((branch) => `refs/heads/${branch}`),
    ...(opts.tags ?? []).map((tag) => `refs/tags/${tag}`),
  ];

  const refCondition = anyOf(refs.map((ref) => `event.data.ref == "${ref}"`));

  const condition = joinConditions([
    refCondition,
    "event.data.deleted != true",
    repoCondition(opts.repo),
  ]);

  return [trigger<GitHubEventData<PushEvent>>("github/push", condition)];
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Run when someone comments a slash command on an issue or pull request.
 *
 * `minPermission` can't be expressed in CEL, so the run checks it and reports
 * "Not permitted" on the check, with a reply to the comment, when the author
 * isn't allowed.
 *
 * ```ts
 * ci.pipeline(
 *   {
 *     id: "prerelease",
 *     on: github.comment({ command: "/prerelease", minPermission: "write" }),
 *   },
 *   async ({ event }) => {
 *     event.data.comment.body; // "/prerelease …"
 *   },
 * );
 * ```
 *
 * @param opts.command - The prefix a comment must start with.
 * @param opts.minPermission - The permission the author needs on the repo.
 * @param opts.repo - Only run for this `owner/name`.
 */
export const comment = (opts: {
  command: string;
  minPermission?: Permission;
  repo?: string;
}): CiTrigger<GitHubEventData<IssueCommentCreatedEvent>>[] => {
  const condition = joinConditions([
    `event.data.comment.body.startsWith("${opts.command}")`,
    repoCondition(opts.repo),
  ]);

  const created = trigger<GitHubEventData<IssueCommentCreatedEvent>>(
    "github/issue_comment.created",
    condition,
  );

  if (opts.minPermission) {
    // The permission can't be part of the trigger the executor sees, so it's
    // remembered here and read by `ci.pipeline` when it wires the trigger up.
    commentPermissions.set(created, {
      command: opts.command,
      minPermission: opts.minPermission,
    });
  }

  return [created];
};

const commentPermissions = new WeakMap<
  object,
  { command: string; minPermission: Permission }
>();

/**
 * The permission a comment trigger asks for, if it asked for one.
 */
export const commentPermissionFor = (
  trigger: CiTrigger,
): { command: string; minPermission: Permission } | undefined =>
  commentPermissions.get(trigger as object);

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Run when GitHub's merge queue asks for checks on a group.
 *
 * @param opts.repo - Only run for this `owner/name`.
 */
export const mergeGroup = (
  opts: { repo?: string } = {},
): CiTrigger<GitHubEventData<MergeGroupChecksRequestedEvent>>[] => [
  trigger<GitHubEventData<MergeGroupChecksRequestedEvent>>(
    "github/merge_group.checks_requested",
    repoCondition(opts.repo),
  ),
];

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Run when a check suite finishes, which is how you react to someone else's
 * checks — "you broke main", or "main is green again".
 *
 * @param opts.branch - Only run for suites on this branch.
 * @param opts.repo - Only run for this `owner/name`.
 */
export const checkSuite = (
  opts: { branch?: string; repo?: string } = {},
): CiTrigger<GitHubEventData<CheckSuiteCompletedEvent>>[] => {
  const condition = joinConditions([
    opts.branch
      ? `event.data.check_suite.head_branch == "${opts.branch}"`
      : undefined,
    repoCondition(opts.repo),
  ]);

  return [
    trigger<GitHubEventData<CheckSuiteCompletedEvent>>(
      "github/check_suite.completed",
      condition,
    ),
  ];
};
