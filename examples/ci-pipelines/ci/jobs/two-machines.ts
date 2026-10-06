import { $, sandbox } from "@inngest/ci";

import { ci } from "../client.ts";

export const twoMachines = ci.job("two-machines", async () => {
  const api = await sandbox("api");
  await api.$`node -e ${"require('http').createServer((_,res)=>res.end('ok')).listen(3000)"}`.background();
  await api.waitForPort(3000);

  await $`node --version`;
});
