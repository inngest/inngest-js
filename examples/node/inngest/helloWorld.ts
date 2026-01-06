import { inngest } from "./client";

export default inngest.createFunction(
  { id: "hello-world" },
  { event: "hello-world" },
  async ({ event, step }) => {
    return {
      message: `Hello, world!`,
    };
  },
);
