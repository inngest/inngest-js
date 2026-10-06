import { changed, github } from "@inngest/ci";

import { ci } from "../client.ts";
import { compat } from "../jobs/compat.ts";
import { e2e } from "../jobs/e2e.ts";
import { lint } from "../jobs/lint.ts";
import { test } from "../jobs/test.ts";

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
