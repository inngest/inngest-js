import { Inngest } from "inngest";
import { otelMiddleware } from "inngest/experimental";
import { schemas } from "./types";

export const inngest = new Inngest({
  id: "my-express-app",
  schemas,
  middleware: [otelMiddleware()],
});
