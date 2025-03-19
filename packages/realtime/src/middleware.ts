import { InngestMiddleware } from "inngest";
import { type InngestApi } from "inngest/api/api";
import { getAsyncCtx } from "inngest/experimental";
import { type Realtime } from "./types";

export const realtimeMiddleware = () => {
  return new InngestMiddleware({
    name: "publish",
    init({ client }) {
      return {
        onFunctionRun() {
          return {
            transformInput({ ctx: { step } }) {
              const publish: Realtime.PublishFn = async (input) => {
                const { topic, channel, data } = await input;

                const store = await getAsyncCtx();
                if (!store) {
                  throw new Error(
                    "No ALS found, but is required for running `publish()`",
                  );
                }

                const subscription: InngestApi.Subscription = {
                  topics: [topic],
                  channel,
                };

                const action = async () => {
                  const result = await client["inngestApi"].publish(
                    subscription,
                    data,
                  );

                  if (!result.ok) {
                    throw new Error(
                      `Failed to publish event: ${result.error?.error}`,
                    );
                  }
                };

                return (
                  store.executingStep
                    ? action()
                    : step.run(`publish:${subscription.channel}`, action)
                ).then(() => {
                  // Always return the data passed in to the `publish` call.

                  return data;
                });
              };

              return {
                ctx: {
                  /**
                   * TODO
                   */
                  publish,
                },
              };
            },
          };
        },
      };
    },
  });
};
