import { Inngest, step } from "inngest";
import { createExperimentalEndpointWrapper } from "inngest/edge";

const wrap = createExperimentalEndpointWrapper({
  client: new Inngest({ id: "bun-sync-example" }),
});

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": wrap(async (_) => {
      const foo = await step.run("example/step", async () => {
        return "Hello from step!";
      });

      return new Response(`Step result: ${foo}`);
    }),
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);
