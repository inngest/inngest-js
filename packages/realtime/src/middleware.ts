import { 
  InngestMiddleware, 
  type MiddlewareOptions,
} from "inngest";
import { getAsyncCtx } from "inngest/experimental";
import type { Realtime } from "./types";

/**
 * Creates middleware that adds real-time publishing capabilities to Inngest functions.
 * 
 * When added to an Inngest client, this middleware provides a `publish` function
 * in the function context that allows you to send real-time messages to channels.
 * 
 * @example
 * ```ts
 * const inngest = new Inngest({
 *   id: 'my-app',
 *   middleware: [realtimeMiddleware()]
 * });
 * 
 * inngest.createFunction(
 *   { id: 'my-function' },
 *   { event: 'my/event' },
 *   async ({ publish }) => {
 *     await publish({
 *       channel: 'my-channel',
 *       topic: 'my-topic',
 *       data: { message: 'Hello!' }
 *     });
 *   }
 * );
 * ```
 * 
 * @returns An Inngest middleware instance that adds the `publish` function to the context
 */
export function realtimeMiddleware() {
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

                return (
                  store.executingStep
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
                   * Publishes a real-time message to a channel.
                   * 
                   * @param input - The message to publish, containing channel, topic, and data
                   * @returns A promise that resolves to the published data
                   */
                  publish,
                },
              };
            },
          };
        },
      };
    },
  }) as InngestMiddleware<MiddlewareOptions & {
    init: () => {
      onFunctionRun: () => {
        transformInput: () => {
          ctx: {
            publish: Realtime.PublishFn;
          };
        };
      };
    };
  }>;
}
