import { Elysia } from "elysia";
import { serve } from "inngest/bun";
import { functions, inngest } from "./inngest";

const handler = serve({
  client: inngest,
  functions,
});

const inngestHandler = new Elysia().all("/api/inngest", ({ request }) =>
  handler(request)
);

const app = new Elysia()
  .use(inngestHandler)
  .get("/", async function () {
    await inngest.send({
      name: "test/hello.world",
      data: {
        email: "testElysia@example.com",
      },
    });
    return { message: "Hello from Elysia" };
  })
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
