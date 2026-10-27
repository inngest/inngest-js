/**
 * @module
 * Serves the example agent functions.
 */
import { createServer } from "node:http";
import { serve } from "inngest/node";
import { boom, chat, client, quick } from "./agents.ts";

const handler = serve({
  client,
  functions: [...chat.functions, ...quick.functions, ...boom.functions],
});

createServer(handler).listen(Number(process.env.PORT));
