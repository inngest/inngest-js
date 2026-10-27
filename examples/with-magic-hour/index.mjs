import { createServer } from "inngest/node";
import { functions, inngest } from "./functions.mjs";

const port = Number(process.env.PORT ?? 3047);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PORT must be an integer from 1024 to 65535.");
}

createServer({ client: inngest, functions }).listen(port, "127.0.0.1", () => {
  console.log(`Inngest endpoint: http://127.0.0.1:${port}/api/inngest`);
});
