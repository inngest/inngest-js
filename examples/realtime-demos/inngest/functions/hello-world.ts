import { inngest } from "../client";

export const helloWorld = inngest.createFunction(
  {
    id: "hello-world",
  },
  {
    event: "app/hello-world.run",
  },
  async ({ step, publish }) => {
    await publish({
      channel: `hello-world`,
      topic: "messages",
      data: `Hello World!`,
    });

    await publish({
      channel: `hello-world`,
      topic: "messages",
      data: `Waiting 2 seconds...`,
    });

    await step.sleep("wait-for-10-seconds", "2s");

    await publish({
      channel: `hello-world`,
      topic: "messages",
      data: `Waiting 3 seconds...`,
    });

    await step.sleep("wait-for-10-seconds", "3s");

    await publish({
      channel: `hello-world`,
      topic: "messages",
      data: `Waiting 1 second...`,
    });

    await step.sleep("wait-for-10-seconds", "1s");

    await publish({
      channel: `hello-world`,
      topic: "messages",
      data: `Bye!`,
    });
  }
);
