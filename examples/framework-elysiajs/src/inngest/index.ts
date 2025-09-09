
import { serve } from "inngest/bun";
import { inngest } from "./index";
import { helloWorld } from "./helloWorld";
import { Elysia } from "elysia";

const handler = serve({
  client: inngest,
  functions: [helloWorld],
});

export const inngestHandler = new Elysia()
.all("/api/inngest",({ request }) => handler(request))

export { inngest } from "./client";


  