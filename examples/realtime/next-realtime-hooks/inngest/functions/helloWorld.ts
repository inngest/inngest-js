import { getInngestApp } from "..";
import { helloChannel } from "../channels";

const inngest = getInngestApp();

export const helloWorld = inngest.createFunction(
  { id: "hello-world", triggers: [{ event: "test/hello.world" }] },
  async ({ event, step, publish, runId }) => {
    const ch = helloChannel;

    await publish(ch.logs, `Hello from ${runId}`);

    //
    // Wait 2 seconds for a cancel signal before re-triggering
    //
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

    return { message: "Hello!", runId };
  },
);
