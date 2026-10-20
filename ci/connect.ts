/**
 * Runs the pipelines as a Connect worker against the Inngest Cloud environment
 * in `~/.config/inngest-ci-dogfood.env`, so webhook-delivered events run on
 * this machine. Same functions as `server.ts`.
 *
 * @module
 */

import { connect } from "inngest/connect";

import { ci, inngest } from "./client.ts";
import "./pipelines/pr.ts";

const connection = await connect({
  apps: [{ client: inngest, functions: ci.functions() }],
});

console.log(`Connected ${ci.functions().length} functions`, connection.state);

process.on("SIGINT", async () => {
  await connection.close();
});
