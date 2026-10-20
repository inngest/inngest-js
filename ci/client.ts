/**
 * The CI client for inngest-js: the one Inngest app every job and pipeline in
 * this folder registers on. Results reach GitHub as commit statuses, written
 * with `GITHUB_TOKEN`; swap `githubToken()` for `githubApp()` to report checks
 * instead. Every pull request and push event is checked against GitHub before
 * it runs, because the Inngest webhook that delivers them can't verify who
 * sent them.
 *
 * @module
 */

import { createCi, githubToken } from "@inngest/ci";
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "inngest-js-ci" });

export const ci = createCi(inngest, {
  github: githubToken(),
  verifyEvents: true,
});
