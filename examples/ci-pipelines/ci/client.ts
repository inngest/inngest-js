import { createCi, fileCacheStore, githubApp } from "@inngest/ci";
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "ci-pipelines" });

export const ci = createCi(inngest, {
  github: githubApp({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  }),
  cacheStore: fileCacheStore(".inngest/ci-cache"),
});
