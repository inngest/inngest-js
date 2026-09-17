import { changed, github } from "inngest/ci";

import { ci } from "./client.ts";
import { compat, deploy, e2e, lint, release, setup, test } from "./jobs.ts";

/**
 * The pull request pipeline.
 *
 * `singleton` cancels the run already in progress for the same pull request,
 * so an old push is marked "Superseded" rather than spinning, and
 * `idempotency` keeps push and pull_request from running the same commit
 * twice.
 */
export const pr = ci.pipeline(
  {
    id: "pr",
    on: github.pullRequest(),
    singleton: { key: "event.data.pull_request.number", mode: "cancel" },
  },
  async () => {
    if (!(await changed({ ignore: ["docs/**", "**/*.md"] }))) {
      return ci.skip("only docs changed");
    }

    await Promise.all([lint(), test(), ...["20", "22"].map(compat)]);

    const preview = await deploy();
    await e2e(preview.url);
  },
);

/**
 * A pipeline that only runs when the app's source changed, to show that a
 * required check still reports when there's nothing to do.
 */
export const docs = ci.pipeline(
  { id: "docs", on: github.pullRequest() },
  async () => {
    if (!(await changed("docs/**", "**/*.md"))) {
      return ci.skip("no documentation changed");
    }

    await setup();
  },
);

/**
 * Push to `main`: wait for approval, then cut a release.
 */
export const releasePipeline = ci.pipeline(
  { id: "release", on: github.push({ branches: ["main"] }) },
  async () => release(),
);

/**
 * A slash command, with the permission check handled for you.
 */
export const prerelease = ci.pipeline(
  {
    id: "prerelease",
    on: github.comment({ command: "/prerelease", minPermission: "write" }),
  },
  async () => {
    await test();
    return { prereleased: true };
  },
);
