import { Inngest } from "inngest";
import { bindingsMiddleware } from "./middleware";

export const inngest = new Inngest({
  id: "my-hono-app",
  middleware: [bindingsMiddleware],
});
