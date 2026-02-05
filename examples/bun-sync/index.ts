import { Inngest, step } from "inngest";
import { endpointAdapter } from "inngest/edge";

const inngest = new Inngest({
  id: "bun-sync-example",
  endpointAdapter: endpointAdapter.withOptions({
    asyncRedirectUrl: "/poll",
  }),
});

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": inngest.endpoint(async (_req) => {
      const foo = await step.run("example/step", async () => {
        return "Hello from step!";
      });

      return new Response(`Step result: ${foo}`);
    }),

    // Proxy endpoint - fetches results from Inngest and decrypts if needed
    "/poll": inngest.endpointProxy(),
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);
