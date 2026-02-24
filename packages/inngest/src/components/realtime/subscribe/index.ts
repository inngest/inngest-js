import type { Inngest } from "../../Inngest.ts";
import type { Realtime } from "../types.ts";
import { TokenSubscription } from "./TokenSubscription.ts";

export const subscribe = async <
  const InputChannel extends Realtime.Channel | string,
  const InputTopics extends (keyof Realtime.Channel.InferTopics<
    Realtime.Channel.AsChannel<InputChannel>
  > &
    string)[],
  const TToken extends Realtime.Subscribe.Token<
    Realtime.Channel.AsChannel<InputChannel>,
    InputTopics
  >,
  const TOutput extends Realtime.Subscribe.StreamSubscription<TToken>,
>(
  token: {
    app?: Inngest.Like;
    channel: Realtime.Subscribe.InferChannelInput<InputChannel>;
    topics: InputTopics;
  },
  callback?: Realtime.Subscribe.Callback<TToken>,
): Promise<TOutput> => {
  const app: Inngest.Any | undefined = token.app as Inngest.Any | undefined;

  const getSubscriptionToken = app
    ? (channel: string, topics: string[]) =>
        (app as Inngest.Any)["inngestApi"].getSubscriptionToken(channel, topics)
    : undefined;

  const subscription = new TokenSubscription({
    token: token as Realtime.Subscribe.Token,
    apiBaseUrl: app?.apiBaseUrl,
    getSubscriptionToken,
  });

  const retStream = subscription.getJsonStream();
  const callbackStream = subscription.getJsonStream();

  await subscription.connect();

  const extras = {
    getJsonStream: () => subscription.getJsonStream(),
    getEncodedStream: () => subscription.getEncodedStream(),
  };

  if (callback) {
    subscription.useCallback(callback, callbackStream);
  } else {
    callbackStream.cancel("Not needed");
  }

  return Object.assign(retStream, extras) as unknown as TOutput;
};

export const getSubscriptionToken = async <
  const InputChannel extends Realtime.Channel | string,
  const InputTopics extends (keyof Realtime.Channel.InferTopics<
    Realtime.Channel.AsChannel<InputChannel>
  > &
    string)[],
  const TToken extends Realtime.Subscribe.Token<
    Realtime.Channel.AsChannel<InputChannel>,
    InputTopics
  >,
>(
  app: Inngest.Like,
  args: {
    channel: Realtime.Subscribe.InferChannelInput<InputChannel>;
    topics: InputTopics;
  },
): Promise<TToken> => {
  const channelId =
    typeof args.channel === "string" ? args.channel : args.channel.name;

  if (!channelId) {
    throw new Error("Channel ID is required to create a subscription token");
  }

  const key = await (app as Inngest.Any)["inngestApi"].getSubscriptionToken(
    channelId,
    args.topics,
  );

  return {
    channel: channelId,
    topics: args.topics,
    key,
  } as TToken;
};
