import { type Realtime } from "./types.js";

/**
 * TODO
 */
export const channel: Realtime.Channel.Builder = (
  /**
   * TODO
   */
  id
) => {
  // eslint-disable-next-line prefer-const, @typescript-eslint/no-explicit-any
  let channelDefinition: any;
  const topics: Record<string, Realtime.Topic.Definition> = {};

  const builder = (...args: unknown[]) => {
    const finalId: string = typeof id === "string" ? id : id(...args);

    const topicsFns = Object.entries(topics).reduce<
      Record<string, (data: unknown) => Realtime.Message.Input>
    >((acc, [name, topic]) => {
      acc[name] = (data: unknown) => {
        return {
          channel: finalId,
          topic: name,
          data,
        };
      };

      return acc;
    }, {});

    const channel: Realtime.Channel = {
      name: finalId,
      topics,
      ...topicsFns,
    };

    return channel;
  };

  const extras: Record<string, unknown> = {
    topics,
    addTopic: (topic: Realtime.Topic.Definition) => {
      topics[topic.name] = topic;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return channelDefinition;
    },
  };

  channelDefinition = Object.assign(builder, extras);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return channelDefinition;
};
