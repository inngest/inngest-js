/**
 * @module
 * Serves the example agent functions.
 */
import { createServer } from "node:http";
import { serve } from "inngest/node";
import { agents, client } from "./agents.ts";

const handler = serve({
  client,
  functions: agents.functions(),
});

createServer(handler).listen(Number(process.env.PORT));
