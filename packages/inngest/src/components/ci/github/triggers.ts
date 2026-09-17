import type { CiTrigger } from "../types.ts";

export type PullRequestAction =
  | "opened"
  | "synchronize"
  | "reopened"
  | "ready_for_review"
  | "closed"
  | "labeled"
  | "unlabeled"
  | "edited";

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

const trigger = (event: string, condition?: string): CiTrigger =>
  condition ? { event, if: condition } : { event };

/**
 * Pull request triggers, one per action so the `if` expression stays readable.
 */
export const pullRequest = (
  opts: {
    branches?: string[];
    types?: PullRequestAction[];
    repo?: string;
  } = {},
): CiTrigger[] => {
  const types = opts.types ?? ["opened", "synchronize", "reopened"];

  const branchCondition = anyOf(
    (opts.branches ?? []).map(
      (branch) => `event.data.pull_request.base.ref == "${branch}"`,
    ),
  );

  const condition = joinConditions([branchCondition, repoCondition(opts.repo)]);

  return types.map((type) => trigger(`github/pull_request.${type}`, condition));
};

/**
 * Push triggers. Deleted-branch pushes are excluded, because there's nothing
 * to check out.
 */
export const push = (
  opts: { branches?: string[]; tags?: string[]; repo?: string } = {},
): CiTrigger[] => {
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

  return [trigger("github/push", condition)];
};

/**
 * Slash-command triggers on issue comments.
 *
 * The permission check can't be expressed in CEL, so the pipeline wrapper
 * checks it at runtime and reports "Not permitted" when the author isn't
 * allowed.
 */
export const comment = (opts: {
  command: string;
  minPermission?: Permission;
  repo?: string;
}): CiTrigger[] => {
  const condition = joinConditions([
    `event.data.comment.body.startsWith("${opts.command}")`,
    repoCondition(opts.repo),
  ]);

  const created = trigger("github/issue_comment.created", condition);

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

export const mergeGroup = (opts: { repo?: string } = {}): CiTrigger[] => [
  trigger("github/merge_group.checks_requested", repoCondition(opts.repo)),
];

export const checkSuite = (
  opts: { branch?: string; repo?: string } = {},
): CiTrigger[] => {
  const condition = joinConditions([
    opts.branch
      ? `event.data.check_suite.head_branch == "${opts.branch}"`
      : undefined,
    repoCondition(opts.repo),
  ]);

  return [trigger("github/check_suite.completed", condition)];
};
