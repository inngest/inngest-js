import { changed, github } from "@inngest/ci";

import { ci } from "../client.ts";
import { base } from "../jobs/base.ts";

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
