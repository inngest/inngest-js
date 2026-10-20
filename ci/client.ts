/**
 * The CI client for inngest-js: the one Inngest app every job and pipeline in
 * this folder registers on. `INNGEST_CI_GITHUB_AUTH` picks how results reach
 * GitHub: `token` (the default) reports commit statuses with `GITHUB_TOKEN`,
 * `app` reports checks as a GitHub App. Every pull request and push event is
 * checked against GitHub before it runs, because the Inngest webhook that
 * delivers them can't verify who sent them.
 *
 * @module
 */

import { createCi, githubApp, githubToken } from "@inngest/ci";
import { Inngest } from "inngest";

const auth = process.env.INNGEST_CI_GITHUB_AUTH ?? "token";

if (auth !== "token" && auth !== "app") {
  throw new Error(
    `INNGEST_CI_GITHUB_AUTH must be "token" or "app", not "${auth}"`,
  );
}

export const inngest = new Inngest({ id: "inngest-js-ci" });

export const ci = createCi(inngest, {
  github:
    auth === "app"
      ? githubApp({
          appId: process.env.GITHUB_APP_ID,
          privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
        })
      : githubToken(),
  verifyEvents: true,
});
