import { Inngest } from "inngest";
import { bindingsMiddleware } from "./middleware";
import { schemas } from "./types";

export const inngest = new Inngest({
  id: "my-hono-app",
  schemas,
  middleware: [bindingsMiddleware],
});
