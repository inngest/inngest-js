import { type InngestApi } from "../api/api.js";
import { getAsyncCtx } from "../components/execution/als.js";
import { InngestMiddleware } from "../components/InngestMiddleware.js";

export const publishMiddleware = () => {
  return new InngestMiddleware({
    name: "publish",
    init({ client }) {
      return {
        onFunctionRun() {
          return {
            transformInput({ ctx: { runId, step } }) {
              const publish = async (
                { topics, channel }: { topics: string[]; channel?: string },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data: any
              ) => {
                const store = await getAsyncCtx();
                if (!store) {
                  throw new Error(
                    "No ALS found, but is required for this middleware"
                  );
                }

                const subscription: InngestApi.Subscription = {
                  topics,
                  channel: channel || runId,
                };

                const action = async () => {
                  const result = await client["inngestApi"].publish(
                    subscription,
                    data
                  );

                  if (!result.ok) {
                    throw new Error(
                      `Failed to publish event: ${result.error?.error}`
                    );
                  }

                  // Return `null` to make sure the return value is always the
                  // same as the step return value
                  return null;
                };

                return store.executingStep
                  ? action()
                  : step.run(`publish:${subscription.channel}`, action);
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
