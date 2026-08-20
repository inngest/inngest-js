import { inngest } from "./client";

// Create an empty array where we'll export future Inngest functions
export const helloWorld = inngest.createFunction(
    { id: "hello-world", triggers: [{ event: "test/hello.world" }] },
    async ({ event, step }) => {
      await step.sleep("wait-a-moment", "1s");
      return { message: `Hello ${event.data.email}!` };
    },
  );
