import { Inngest } from "inngest";
import { createCi, fileCacheStore, githubApp } from "inngest/ci";

export const inngest = new Inngest({ id: "ci-pipelines" });

/**
 * In dev, checks print to this terminal and the cache lives on disk, so a
 * second run can restore work from the first.
 *
 * Set `INNGEST_CI_GITHUB=live` with a GitHub App to post real checks.
 */
export const ci = createCi(inngest, {
  github: githubApp({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  }),
  cacheStore: fileCacheStore(".inngest/ci-cache"),
});
