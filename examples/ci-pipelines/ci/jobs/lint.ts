import { $, checkout, from } from "@inngest/ci";

import { ci } from "../client.ts";
import { appDir } from "../helpers.ts";
import { base } from "./base.ts";

export const lint = ci.job("lint", async () => {
  await from(base);
  await checkout();

  await $`pnpm lint`.cwd(appDir);
});
