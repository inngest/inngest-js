import { $, checkout, from } from "@inngest/ci";

import { ci } from "../client.ts";
import { appDir } from "../helpers.ts";
import { base } from "./base.ts";

export const compat = ci.matrix(
  { id: "compat", axes: { node: ["20", "22"] } },
  async ({ node }) => {
    await from(base);
    await checkout();

    await $`node --version`;

    await $`pnpm test`.cwd(appDir).env({ NODE_VERSION: node });

    return node;
  },
);
