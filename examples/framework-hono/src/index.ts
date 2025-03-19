import { Hono } from "hono";
import { serve } from "inngest/hono";
import { type Bindings } from "./bindings";
import { functions, inngest } from "./inngest";

const app = new Hono<{ Bindings: Bindings }>();

app.on(
  ["GET", "PUT", "POST"],
  "/api/inngest",
  serve({
    client: inngest,
    functions,
  })
);

export default app;
