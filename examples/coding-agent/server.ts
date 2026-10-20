import { createServer } from "node:http";

import { serve } from "inngest/node";

import { coder, inngest } from "./agent.ts";

const handler = serve({ client: inngest, functions: [coder] });

createServer((req, res) => {
  return handler(req, res);
}).listen(Number(process.env.PORT ?? 3940));
