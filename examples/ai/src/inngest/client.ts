import { Inngest } from "inngest";
import { aiMiddleware } from "inngest/experimental";

export const inngest = new Inngest({
  id: "example-ai-app",
  middleware: [aiMiddleware()],
});
