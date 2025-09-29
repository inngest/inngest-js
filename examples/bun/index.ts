import { serve } from "inngest/bun";
import { functions, inngest } from "./inngest";

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": async _ => {
      await inngest.send({
        name: "demo/event.sent",
        data: {
          message: "Message from Bun Server",
        },
      });
      return new Response("Hello world!");
    },
    "/api/inngest": (request: Request) => {
      return serve({ client: inngest, functions })(request);
    },
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);