import { github } from "@inngest/ci";

import { ci } from "../client.ts";
import { test } from "../jobs/test.ts";

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
