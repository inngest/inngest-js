import { inngest } from "./client";

export default inngest.createFunction(
  { id: "hello-world", triggers: [{ event: "demo/hello.world" }] },
  async ({ event, step }) => {
    await step.sleep("wait-a-moment", "1s");
    return { event, body: "Hello, World!" };
  }
);
