import { Inngest, step } from "inngest";
import { endpointAdapter } from "inngest/edge";

const inngest = new Inngest({ id: "bun-sync-example", endpointAdapter });

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": inngest.endpoint(async (_) => {
      const foo = await step.run("example/step", async () => {
        return "Hello from step!";
      });

      await step.run("step-2", () => {
        throw new Error("test");
      });

      await step.run("step-3", () => {});

      return new Response(`Step result: ${foo}`);
    }),
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);
