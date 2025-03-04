import { type InngestApi } from "../../api/api.js";
import { getAsyncCtx } from "../../components/execution/als.js";
import { InngestMiddleware } from "../../components/InngestMiddleware.js";
import { type Realtime } from "./types.js";

export const realtimeMiddleware = () => {
  return new InngestMiddleware({
    name: "publish",
    init({ client }) {
      return {
        onFunctionRun() {
          return {
            transformInput({ ctx: { step } }) {
              const publish: Realtime.PublishFn = async (input) => {
                const store = await getAsyncCtx();
                if (!store) {
                  throw new Error(
                    "No ALS found, but is required for this middleware"
                  );
                }

                const subscription: InngestApi.Subscription = {
                  topics: [input.topic],
                  channel: input.channel,
                };

                const action = async () => {
                  const result = await client["inngestApi"].publish(
                    subscription,
                    input.data
                  );

                  if (!result.ok) {
                    throw new Error(
                      `Failed to publish event: ${result.error?.error}`
                    );
                  }
                };

                // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                return (
                  store.executingStep
                    ? action()
                    : step.run(`publish:${subscription.channel}`, action)
                ).then(() => {
                  // Always return the data passed in to the `publish` call.
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                  return input.data;
                });
              };

              return {
                ctx: {
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
