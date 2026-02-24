import { realtime } from "inngest";

//
// Shared channel definition — imported by both the function (to publish)
// and the client (to subscribe). Types flow E2E.
//
export const helloChannel = realtime.channel({
  name: "hello-world",
  topics: {
    logs: realtime.type<string>(),
  },
});
