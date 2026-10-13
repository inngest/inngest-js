import { z } from "zod";

import { ci } from "../client.ts";
import { build } from "../jobs/build.ts";

export const deploy = ci.pipeline(
  {
    id: "deploy",
    on: ci.manual({
      pipelineId: "deploy",
      schema: z.object({
        target: z.enum(["web", "api"]).describe("Where to deploy"),
        dryRun: z
          .boolean()
          .default(true)
          .describe("Build and check without releasing"),
        note: z.string().optional().describe("Shown on the release"),
      }),
    }),
  },
  async ({ event, logger }) => {
    logger.info(
      { dryRun: event.data.dryRun, note: event.data.note },
      "starting deploy",
    );

    await build({ target: event.data.target });
  },
);
