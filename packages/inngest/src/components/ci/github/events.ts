import type { RepoContext } from "../types.ts";

/**
 * The canonical Inngest event name for a GitHub webhook delivery.
 *
 * `github/${X-GitHub-Event}` when the payload has no action, and
 * `github/${X-GitHub-Event}.${action}` when it does.
 */
export const githubEventName = (
  event: string,
  payload: { action?: string } | undefined,
): string =>
  payload?.action ? `github/${event}.${payload.action}` : `github/${event}`;

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Source for an Inngest webhook transform. Paste this into the webhook's
 * transform box in the Inngest dashboard.
 *
 * It's plain JavaScript because it runs in Inngest's transform sandbox, and it
 * looks headers up case-insensitively because different proxies normalise them
 * differently.
 */
export const githubWebhookTransform = `function transform(evt, headers, queryParams, raw) {
  function header(name) {
    if (!headers) return undefined;
    var lower = name.toLowerCase();
    for (var key in headers) {
      if (key.toLowerCase() === lower) {
        var value = headers[key];
        return Array.isArray(value) ? value[0] : value;
      }
    }
    return undefined;
  }

  var event = header("x-github-event") || "unknown";
  var delivery = header("x-github-delivery");
  var name = evt && evt.action ? "github/" + event + "." + evt.action : "github/" + event;
  var installationId =
    evt && evt.installation && evt.installation.id ? evt.installation.id : undefined;

  return {
    name: name,
    data: Object.assign({}, evt, {
      _github: {
        event: event,
        delivery: delivery,
        installationId: installationId,
      },
    }),
  };
}`;

interface GithubEventData {
  _github?: { event?: string; delivery?: string; installationId?: number };
  local?: { path: string; baseRef: string };
  repository?: {
    full_name?: string;
    owner?: { login?: string };
    name?: string;
  };
  installation?: { id?: number };
  pull_request?: {
    number?: number;
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
    base?: { sha?: string; ref?: string };
  };
  number?: number;
  before?: string;
  after?: string;
  ref?: string;
  deleted?: boolean;
  issue?: { number?: number; pull_request?: unknown };
  comment?: { body?: string; user?: { login?: string } };
  merge_group?: { head_sha?: string; base_ref?: string };
  check_run?: { head_sha?: string };
  check_suite?: { head_sha?: string; head_branch?: string };
}

/**
 * Derive where a run came from, using only the trigger event.
 *
 * Returns `undefined` for triggers with no repository of their own, like
 * crons; `ci.pipeline({ repo })` resolves those in a step instead.
 */
export const repoContextFromEvent = (
  event: { name?: string; data?: unknown } | undefined,
): RepoContext | undefined => {
  const data = (event?.data ?? {}) as GithubEventData;
  const fullName = data.repository?.full_name;

  if (!fullName) {
    return undefined;
  }

  const [owner = "", name = ""] = fullName.split("/");
  const installationId = data._github?.installationId ?? data.installation?.id;

  const base: RepoContext = {
    owner,
    name,
    fullName,
    sha: "",
    trigger: event?.name,
    ...(installationId ? { installationId } : {}),
    ...(data.local ? { local: data.local } : {}),
  };

  if (data.pull_request) {
    const number = data.pull_request.number ?? data.number;
    return {
      ...base,
      sha: data.pull_request.head?.sha ?? "",
      ref: data.pull_request.head?.ref,
      baseRef: data.pull_request.base?.ref,
      baseSha: data.pull_request.base?.sha,
      ...(number
        ? {
            pullRequest: {
              number,
              headRef: data.pull_request.head?.ref ?? "",
              fork:
                (data.pull_request.head?.repo?.full_name ?? fullName) !==
                fullName,
            },
          }
        : {}),
    };
  }

  if (data.merge_group?.head_sha) {
    return {
      ...base,
      sha: data.merge_group.head_sha,
      baseRef: data.merge_group.base_ref,
    };
  }

  if (data.check_run?.head_sha || data.check_suite?.head_sha) {
    return {
      ...base,
      sha: data.check_run?.head_sha ?? data.check_suite?.head_sha ?? "",
      ref: data.check_suite?.head_branch,
    };
  }

  if (data.after) {
    return {
      ...base,
      sha: data.after,
      ref: data.ref,
      baseSha: data.before,
      baseRef: data.ref?.replace(/^refs\/heads\//, ""),
    };
  }

  if (data.issue) {
    // Comment triggers know the pull request but not its head commit; the
    // pipeline wrapper resolves that in a step.
    return {
      ...base,
      ...(data.issue.number
        ? {
            pullRequest: {
              number: data.issue.number,
              headRef: "",
              fork: false,
            },
          }
        : {}),
    };
  }

  return base;
};

/**
 * The comment body for a `github.comment()` trigger, if this event is one.
 */
export const commentBody = (event: { data?: unknown } | undefined): string =>
  ((event?.data as GithubEventData)?.comment?.body ?? "").trim();

/**
 * The login of whoever wrote the comment, for the permission check.
 */
export const commentAuthor = (
  event: { data?: unknown } | undefined,
): string | undefined => (event?.data as GithubEventData)?.comment?.user?.login;
