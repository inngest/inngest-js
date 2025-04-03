import { channel, topic } from "@inngest/realtime";
import { getInngestApp } from "..";

const inngest = getInngestApp();

export const helloChannel = channel("hello-world").addTopic(
  topic("logs").type<string>()
);

export const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "test/hello.world" },
  async ({ event, step, publish, runId }) => {
    await Promise.all([
      publish(helloChannel().logs(`Hello ${event.data.email} from ${runId}`)),

      step.sleep("holdit", 1000).then(() =>
        step.sendEvent("retrigger", {
          name: "test/hello.world",
          data: { email: event.data.email },
        })
      ),
    ]);

    return { message: `Hello ${event.data.email}!`, runId };
  }
);
