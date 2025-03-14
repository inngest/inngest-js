import { Inngest } from "inngest";
import { otlpMiddleware } from "inngest/experimental";
import { schemas } from "./types";

export const inngest = new Inngest({
  id: "my-express-app",
  schemas,
  middleware: [otlpMiddleware()],
});
