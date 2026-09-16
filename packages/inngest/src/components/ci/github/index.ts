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
  stickyComment,
  upsertPullRequest,
  forcePushRef,
  canUser,
  waitForChecks,
  waitForWorkflow,
  paginate,
  graphql,

  // Context and escape hatches
  repo,
  token,
  octokit,
};

export type Github = typeof github;
