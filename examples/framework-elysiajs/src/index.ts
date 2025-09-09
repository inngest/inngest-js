import { Elysia } from "elysia";
import { inngest } from "./inngest";
import { inngestHandler } from "./inngest";

const app = new Elysia()
.use(inngestHandler)
.get("/", async function ({ status }) {
  await inngest.send({
    name: "test/hello.world",
    data: {
      email: "testElysia@example.com",
    },
  })
  return { message: "Hello from Elysia"}
}).listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
