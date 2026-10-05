import { changed, github } from "@inngest/ci";
import { z } from "zod";

import { ci } from "./client.ts";
import { base, build, compat, e2e, lint, release, test } from "./jobs.ts";

export const pr = ci.pipeline(
  {
    id: "pr",
    on: github.pullRequest(),
    singleton: { key: "event.data.pull_request.number", mode: "cancel" },
  },
  async ({ event, logger }) => {
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

    await Promise.all([lint(), test(), compat()]);

    await e2e();
  },
);

export const docs = ci.pipeline(
  {
    id: "docs",
    on: github.pullRequest(),
  },
  async () => {
    if (!(await changed("docs/**", "**/*.md"))) {
      return ci.skip("no documentation changed");
    }

    await base();
  },
);

export const releasePipeline = ci.pipeline(
  {
    id: "release",
    on: github.push({ branches: ["main"] }),
  },
  async ({ event }) => {
    if (event.data.deleted) {
      return ci.skip("the branch was deleted");
    }

    if (ci.local) {
      return ci.skip("not releasing from a local run");
    }

    return release();
  },
);

export const deploy = ci.pipeline(
  {
    id: "deploy",
    on: ci.manual({
      pipelineId: "deploy",
      schema: z.object({ target: z.enum(["web", "api"]) }),
    }),
  },
  async ({ event }) => {
    await build({ target: event.data.target });
  },
);

export const prerelease = ci.pipeline(
  {
    id: "prerelease",
    on: github.comment({ command: "/prerelease", minPermission: "write" }),
  },
  async ({ event }) => {
    const [, channel = "next"] = event.data.comment.body.trim().split(/\s+/);

    await test();

    return { prereleased: true, channel };
  },
);
