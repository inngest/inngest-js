// Initialize otel middleware first
import { extendedTracesMiddleware } from "inngest/experimental";
const otel = extendedTracesMiddleware();

// Then everything else
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "my-express-app",
  middleware: [otel],
});
