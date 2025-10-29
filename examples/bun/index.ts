import { Inngest, step } from "inngest";
import { createEndpointWrapper } from "inngest/edge";

const inngest = new Inngest({
  id: "my-bun-app",
});

const wrap = createEndpointWrapper({
  client: inngest,
});

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": async (_) => {
      await inngest.send({
        name: "demo/event.sent",
        data: {
          message: "Message from Bun Server",
        },
      });
      return new Response("Hello world!");
    },
    "/api/inngest": wrap(async (req: Request) => {
      console.log("=============== STARTED BUN REQUEST ===============");

      const foo = await step.run("my-step-id", async () => {
        console.log("=============== STARTED STEP ===============");

        return "i did foo";
      });

      console.log("=============== FINISHED STEP ===============");

      return new Response(`test test test: ${foo}`);
    }),
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);
