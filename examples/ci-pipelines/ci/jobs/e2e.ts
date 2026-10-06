import { $, checkout, from, waitForHttp } from "@inngest/ci";

import { ci } from "../client.ts";
import { base } from "./base.ts";

export const e2e = ci.job("e2e", async () => {
  await from(base);
  await checkout();

  await $`node -e ${"require('http').createServer((_,res)=>res.end('ok')).listen(3000)"}`.background();
  await waitForHttp("http://127.0.0.1:3000");

  await $`curl -fsS http://127.0.0.1:3000`;
});
