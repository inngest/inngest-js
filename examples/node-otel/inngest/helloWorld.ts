import { inngest } from "./client";

export default inngest.createFunction(
  { id: "hello-world" },
  { event: "demo/event.sent" },
  async ({ event, step }) => {
    const foo = await fetch("https://thelinell.com")

    const result = await step.run("fetch_page", async () => {
      return await fetch("http://localhost:3000/api/inngest");
    })

    const bar = await fetch("https://innget.com")

    return {
      message: `Hello ${event.name}!`,
    };
  }
);
