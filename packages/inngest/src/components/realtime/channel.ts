import type { Realtime } from "./types.ts";

type ChannelOptions<
  TName extends string | ((...args: never[]) => string),
  TTopics extends Realtime.TopicsConfig,
> = {
  name: TName;
  topics: TTopics;
};

type InferChannelReturn<
  TName extends string | ((...args: never[]) => string),
  TTopics extends Realtime.TopicsConfig,
> = TName extends string
  ? Realtime.ChannelInstance<TName, TTopics> & {
      $infer: { [K in keyof TTopics]: Realtime.InferTopicData<TTopics[K]> };
    }
  : TName extends (...args: infer TArgs) => string
    ? Realtime.ChannelDef<(...args: TArgs) => string, TTopics> & {
        $infer: { [K in keyof TTopics]: Realtime.InferTopicData<TTopics[K]> };
        $params: TArgs[0];
      }
    : never;

const createTopicAccessors = (
  channelName: string,
  topics: Realtime.TopicsConfig
): Record<string, Realtime.TopicRef> => {
  const accessors: Record<string, Realtime.TopicRef> = {};
  for (const [topicName, config] of Object.entries(topics)) {
    accessors[topicName] = {
      channel: channelName,
      topic: topicName,
      config,
    };
  }
  return accessors;
};

export const channel = <
  const TName extends string | ((...args: never[]) => string),
  const TTopics extends Realtime.TopicsConfig,
>(
  options: ChannelOptions<TName, TTopics>
): InferChannelReturn<TName, TTopics> => {
  const { name, topics } = options;

  if (typeof name === "function") {
    //
    // Parameterized channel: calling the definition with params returns a ChannelInstance
    const def = (...args: unknown[]) => {
      const resolvedName = (name as (...args: unknown[]) => string)(...args);
      return {
        name: resolvedName,
        topics,
        ...createTopicAccessors(resolvedName, topics),
      };
    };

    Object.defineProperties(def, {
      topics: { value: topics, enumerable: true },
      $infer: { get: () => topics },
      $params: { get: () => undefined },
    });

    // biome-ignore lint/suspicious/noExplicitAny: sacrifice for clean generics
    return def as any;
  }

  //
  // Static channel: the definition itself acts as a ChannelInstance
  const instance = {
    name,
    topics,
    ...createTopicAccessors(name, topics),
    get $infer() {
      return topics;
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: sacrifice for clean generics
  return instance as any;
};
