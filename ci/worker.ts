/**
 * The always-on inngest-js CI worker: an Inngest Connect worker for the pipelines, with outbound
 * connections only. It holds no state, so a restart is safe at any time.
 *
 * @module
 */

import { connect } from "inngest/connect";

import { ci, inngest } from "./client.ts";
import "./pipelines/agents.ts";
import "./pipelines/pr.ts";

const worker = await connect({
  apps: [{ client: inngest, functions: ci.functions() }],
  instanceId: process.env.FLY_MACHINE_ID,
});

console.log(`inngest-js-ci: connected ${ci.functions().length} functions`);

await worker.closed;
