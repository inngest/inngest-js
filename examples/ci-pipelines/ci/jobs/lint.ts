import { $, checkout } from "@inngest/ci";

import { ci } from "../client.ts";
import { appDir } from "../helpers.ts";
import { base } from "./base.ts";

export const lint = ci.job({ id: "lint", from: base }, async () => {
  await checkout();

  await $`pnpm lint`.cwd(appDir);
});
