/**
 * The CI client for inngest-js: the one Inngest app every job and pipeline in
 * this folder registers on.
 *
 * @module
 */

import { createCi, githubApp } from "@inngest/ci";
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "inngest-js-ci" });

export const ci = createCi(inngest, {
  github: githubApp({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  }),
});
