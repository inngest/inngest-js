import { Inngest } from "inngest";
import { realtimeMiddleware } from "@inngest/realtime";

export const inngest = new Inngest({
  id: "campaigncraft-app",
  middleware: [realtimeMiddleware()],
});
