import { Inngest, dependencyInjectionMiddleware } from "inngest";

export const inngest = new Inngest({
  id: "my-defer-poc",
  middleware: [dependencyInjectionMiddleware({ appVersion: "1.2.3" })],
});
