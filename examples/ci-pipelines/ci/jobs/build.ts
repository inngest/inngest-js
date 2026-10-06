import { $, checkout, from } from "@inngest/ci";
import { z } from "zod";

import { ci } from "../client.ts";
import { appDir } from "../helpers.ts";
import { base } from "./base.ts";

export const build = ci.job(
  {
    id: "build",
    input: z.object({
      target: z.enum(["web", "api"]).describe("What to build"),
      minify: z.boolean().default(true).describe("Minify the output"),
    }),
  },
  async ({ target, minify }) => {
    await from(base);
    await checkout();

    await $`pnpm build`
      .cwd(appDir)
      .env({ BUILD_TARGET: target, BUILD_MINIFY: String(minify) });

    return target;
  },
);
