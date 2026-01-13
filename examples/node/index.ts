import { createServer } from "inngest/node";
import { functions, inngest } from "./inngest";

const server = createServer({ client: inngest, functions });

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
