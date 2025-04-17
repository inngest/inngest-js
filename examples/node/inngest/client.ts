// Initialize otel middleware first
import { otelMiddleware } from "inngest/experimental";
const otel = otelMiddleware();

// Then everything else
import { Inngest } from "inngest";
import { schemas } from "./types";

export const inngest = new Inngest({
  id: "my-express-app",
  schemas,
  middleware: [otel],
});
