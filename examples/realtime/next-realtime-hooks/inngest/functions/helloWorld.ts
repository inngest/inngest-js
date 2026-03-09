import { channel, topic } from "@inngest/realtime";
import { getInngestApp } from "..";

const inngest = getInngestApp();

export const helloChannel = channel("hello-world").addTopic(
  topic("logs").type<string>()
);

export const helloWorld = inngest.createFunction(
  { id: "hello-world", triggers: [{ event: "test/hello.world" }] },
  async ({ event, step, publish, runId }) => {
    publish(helloChannel().logs(`Hello from ${runId}`));

    // wait 2 seconds before next iteration while waiting for a potential cancel signal
    const result = await step.waitForEvent("cancel-signal", {
      event: "test/cancel.signal",
      timeout: 2000,
    });

    if (!result) {
      await step.sendEvent("retrigger", {
        name: "test/hello.world",
        data: { email: event.data.email },
      });
    }

    return { message: `Hello!`, runId };
  }
);
