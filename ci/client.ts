/**
 * The CI client for inngest-js: the one Inngest app every job and pipeline in
 * this folder registers on. Results reach GitHub as checks, written as the GitHub
 * App in `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.
 *
 * @module
 */

import { createCi, githubApp } from "@inngest/ci";
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "inngest-js-ci" });

export const ci = createCi(inngest, {
  github: githubApp(),
});
