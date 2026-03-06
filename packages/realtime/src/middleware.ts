import { InngestMiddleware } from "inngest";
import { getAsyncCtx } from "inngest/experimental";
import type { Realtime } from "./types";

export const realtimeMiddleware = () => {
  return new InngestMiddleware({
    name: "publish",
    init({ client }) {
      return {
        onFunctionRun({ ctx: { runId } }) {
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

                const publishOpts = {
                  topics: [topic],
                  channel,
                  runId,
                };

                const action = async () => {
                  const result = await client["inngestApi"].publish(
                    publishOpts,
                    data,
                  );

                  if (!result.ok) {
                    throw new Error(
                      `Failed to publish event: ${result.error?.error}`,
                    );
                  }
                };

                // This could be a couple of different versions, but is now
                // stable in the latter format.
                const isExecutingStep =
                  store.executingStep ||
                  // biome-ignore lint/suspicious/noExplicitAny: Testing across version boundaries
                  (store as any).execution?.executingStep;

                return (
                  isExecutingStep
                    ? action()
                    : step.run(`publish:${publishOpts.channel}`, action)
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

// Re-export types from here, as this is used as a separate entrypoint now
export * from "./types";
