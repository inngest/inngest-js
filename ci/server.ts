/**
 * Serves the pipelines to Inngest. `inngest-ci` starts this for local runs.
 *
 * @module
 */

import { createServer } from "inngest/node";

import { ci, inngest } from "./client.ts";
import "./pipelines/pr.ts";

const port = Number(process.env.PORT ?? 3939);

createServer({ client: inngest, functions: ci.functions() }).listen(
  port,
  () => {
    console.log(`Serving ${ci.functions().length} functions on port ${port}`);
  },
);
