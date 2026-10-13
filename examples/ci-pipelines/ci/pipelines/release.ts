import { github } from "@inngest/ci";

import { ci } from "../client.ts";
import { release } from "../jobs/release.ts";

export const releasePipeline = ci.pipeline(
  {
    id: "release",
    on: github.push({ branches: ["main"] }),
  },
  async ({ event }) => {
    if (event.data.deleted) {
      return ci.skip("the branch was deleted");
    }

    return release();
  },
);
