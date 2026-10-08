import { files } from "@inngest/ci";

import { ci } from "../client.ts";
import { install } from "../helpers.ts";

export const base = ci.job(
  {
    id: "base",
    cache: {
      key: files("examples/ci-pipelines/app/package.json", "pnpm-lock.yaml"),
      warm: [{ cron: "0 3 * * *" }],
    },
  },
  async () => {
    await install();
  },
);
