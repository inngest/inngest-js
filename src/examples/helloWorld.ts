import { inngest } from "./client";

export default inngest.createFunction(
  { name: "Hello World" },
  { event: "demo/event.sent" },
  () => "Hello, Inngest!"
);
