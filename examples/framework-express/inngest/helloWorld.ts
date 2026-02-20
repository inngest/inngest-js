import { inngest } from "./client";

export default inngest.createFunction(
  { id: "hello-world", triggers: [{ event: "demo/event.sent" }] },
  async ({ event, step, logger }) => {
    console.log("\n\nfn")
    logger.info("hi")
    return {
      message: `Hello ${event.name}!`,
    };
  }
);
