import { Hono } from "hono";
import { serve } from "inngest/hono";
import { functions, inngest } from "./inngest";
import { renderer } from "./renderer";

const app = new Hono();

app.use(renderer);

app.get("/", (c) => {
  return c.render(<h1>Hello!</h1>);
});

app.on(
  ["GET", "POST", "PUT"],
  "/api/inngest",
  serve({ client: inngest, functions })
);

export default app;
