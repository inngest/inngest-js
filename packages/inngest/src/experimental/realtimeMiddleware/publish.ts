import { type InngestApi } from "../../api/api.js";
import { Inngest } from "../../components/Inngest.js";
import { type Realtime } from "./types.js";

const inngest = new Inngest({ id: "test-app" });

// Only used for type testing. Not implementing here outside of runs.
export const publish: Realtime.PublishFn = async (input) => {
  const subscription: InngestApi.Subscription = {
    topics: [input.topic],
    channel: input.channel,
  };

  const result = await inngest["inngestApi"].publish(subscription, input.data);

  if (!result.ok) {
    throw new Error(`Failed to publish event: ${result.error?.error}`);
  }

  console.log({ result });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return input.data;
};
