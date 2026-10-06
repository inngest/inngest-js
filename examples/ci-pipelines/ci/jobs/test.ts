import { $, checkout, from, report } from "@inngest/ci";

import { ci } from "../client.ts";
import { appDir } from "../helpers.ts";
import { base } from "./base.ts";

export const test = ci.job("test", async () => {
  await from(base);
  await checkout();

  const result = await $`pnpm test`.cwd(appDir).retries(1);

  await report.summary(`Tests exited with ${result.exitCode}`);

  return result.exitCode;
});
