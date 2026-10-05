/**
 * The `github` namespace: triggers and helpers gathered into one export.
 *
 * @module
 */

import { countApi } from "../pipeline/scope.ts";
import {
  canUser,
  forcePushRef,
  graphql,
  octokit,
  paginate,
  repo,
  stickyComment,
  token,
  upsertPullRequest,
  waitForChecks,
  waitForWorkflow,
} from "./helpers.ts";
import { rest } from "./rest.ts";
import {
  checkSuite,
  comment,
  mergeGroup,
  pullRequest,
  push,
} from "./triggers.ts";

/**
 * Count each call of a helper in the run's metadata, then call it.
 *
 * Only the exported helpers are wrapped, so CI using one of its own isn't
 * counted as the user using it.
 */
// biome-ignore lint/suspicious/noExplicitAny: wraps helpers of any signature
const counted = <TFn extends (...args: any[]) => any>(fn: TFn): TFn => {
  return ((...args: Parameters<TFn>) => {
    countApi("githubHelpers");

    return fn(...args);
  }) as TFn;
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Triggers, the whole GitHub REST API, and a few helpers for the things CI
 * needs that take several calls or a durable wait.
 */
export const github = {
  // Triggers
  pullRequest,
  push,
  comment,
  mergeGroup,
  checkSuite,

  // The API
  rest,

  // Helpers
  stickyComment: counted(stickyComment),
  upsertPullRequest: counted(upsertPullRequest),
  forcePushRef: counted(forcePushRef),
  canUser: counted(canUser),
  waitForChecks,
  waitForWorkflow,
  paginate: counted(paginate),
  graphql: counted(graphql),

  // Context and escape hatches
  repo: counted(repo),
  token: counted(token),
  octokit: counted(octokit),
};

export type Github = typeof github;
