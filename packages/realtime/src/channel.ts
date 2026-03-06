import { topic } from "./topic";
import { type Realtime } from "./types";

/**
 * TODO
 */
export const channel: Realtime.Channel.Builder = (
  /**
   * TODO
   */
  id,
) => {
  // eslint-disable-next-line prefer-const, @typescript-eslint/no-explicit-any
  let channelDefinition: any;
  const topics: Record<string, Realtime.Topic.Definition> = {};

  const builder = (...args: unknown[]) => {
    const finalId: string = typeof id === "string" ? id : id(...args);

    const topicsFns = Object.entries(topics).reduce<
      Record<string, (data: unknown) => Promise<Realtime.Message.Input>>
    >((acc, [name, topic]) => {
      acc[name] = createTopicFn(finalId, topic);

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

      return channelDefinition;
    },
  };

  channelDefinition = Object.assign(builder, extras);

  return channelDefinition;
};

/**
 * TODO
 */
export const typeOnlyChannel = <
  TChannelDef extends Realtime.Channel.Definition,
  TId extends string = Realtime.Channel.Definition.InferId<TChannelDef>,
  TTopics extends Record<
    string,
    Realtime.Topic.Definition
  > = Realtime.Channel.Definition.InferTopics<TChannelDef>,
  TOutput extends Realtime.Channel = Realtime.Channel<TId, TTopics>,
>(
  /**
   * TODO
   */
  id: TId,
) => {
  const blankChannel = {
    ...channel(id),
    topics: new Proxy(
      {},
      {
        get: (target, prop) => {
          if (prop in target) {
            return target[prop as keyof typeof target];
          }

          if (typeof prop === "string") {
            return topic(prop);
          }
        },
      },
    ),
  };

  const ch = new Proxy(blankChannel, {
    get: (target, prop) => {
      if (prop in target) {
        return target[prop as keyof typeof target];
      }

      if (typeof prop === "string") {
        return createTopicFn(id, topic(prop));
      }
    },
  });

  return ch as unknown as TOutput;
};

const createTopicFn = (channelId: string, topic: Realtime.Topic.Definition) => {
  return async (data: unknown) => {
    const schema = topic.getSchema();
    if (schema) {
      try {
        await schema["~standard"].validate(data);
      } catch (err) {
        console.error(
          `Failed schema validation for channel "${channelId}" topic "${topic.name}":`,
          err,
        );
        throw new Error("Failed schema validation");
      }
    }

    return {
      channel: channelId,
      topic: topic.name,
      data,
    };
  };
};
