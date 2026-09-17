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
  async ({ event, logger }) => {
    // `event` is typed by the triggers: this is a pull request event, so
    // `pull_request` is there without a cast or a schema.
    logger.info(
      {
        pr: event.data.pull_request.number,
        sha: event.data.pull_request.head.sha,
        draft: event.data.pull_request.draft,
      },
      "starting pull request pipeline",
    );

    if (event.data.pull_request.draft) {
      return ci.skip("the pull request is a draft");
    }

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
  async ({ event }) => {
    // A push event, so `after` is the commit that was pushed.
    if (event.data.deleted) {
      return ci.skip("the branch was deleted");
    }

    return release();
  },
);

/**
 * A slash command, with the permission check handled for you.
 */
export const prerelease = ci.pipeline(
  {
    id: "prerelease",
    on: github.comment({ command: "/prerelease", minPermission: "write" }),
  },
  async ({ event }) => {
    // A comment event, so the command's arguments are right there.
    const [, channel = "next"] = event.data.comment.body.trim().split(/\s+/);

    await test();

    return { prereleased: true, channel };
  },
);
