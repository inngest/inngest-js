/**
 * Serves the pipelines to Inngest. `inngest-ci` starts this for local runs.
 *
 * @module
 */

import { createServer } from "node:http";

import { serve } from "inngest/node";

import { ci, inngest } from "./client.ts";
import "./pipelines/pr.ts";

const port = Number(process.env.PORT ?? 3939);

const handler = serve({
  client: inngest,
  functions: ci.functions(),
});

createServer((req, res) => {
  return handler(req, res);
}).listen(port, () => {
  console.log(`Serving ${ci.functions().length} functions on port ${port}`);
});
