import { createServer } from "node:http";

import { serve } from "inngest/node";

import { ci, inngest } from "./ci/client.ts";

// Importing the pipelines registers them with the CI client.
import "./ci/pipelines.ts";

const port = Number(process.env.PORT ?? 3939);

const handler = serve({
  client: inngest,
  functions: ci.functions(),
});

createServer((req, res) => {
  if (req.url?.startsWith("/api/inngest")) {
    return handler(req, res);
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    [
      "Inngest CI example.",
      "",
      `Functions are served at http://localhost:${port}/api/inngest`,
      "",
      "Send a pipeline a local event with:",
      "  pnpm ci:send pr",
    ].join("\n"),
  );
}).listen(port, () => {
  console.log(
    { port, functions: ci.functions().length },
    `CI example listening on http://localhost:${port}/api/inngest`,
  );
});
