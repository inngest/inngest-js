import type { Inngest } from "../../Inngest.ts";
import type { Realtime } from "../types.ts";
import { TokenSubscription } from "./TokenSubscription.ts";

type ChannelTopicNames<InputChannel extends Realtime.ChannelInput> = Extract<
  keyof Realtime.Channel.InferTopics<InputChannel>,
  string
>;

type ChannelTopicsInput<InputChannel extends Realtime.ChannelInput> = [
  ChannelTopicNames<InputChannel>,
] extends [never]
  ? string[]
  : string extends ChannelTopicNames<InputChannel>
    ? string[]
    : ChannelTopicNames<InputChannel>[];

type SubscribeBaseArgs<
  InputChannel extends Realtime.ChannelInput,
  InputTopics extends ChannelTopicsInput<InputChannel>,
> = {
  app?: Inngest.Like;
  key?: string;
  channel: InputChannel;
  topics: InputTopics;
  validate?: boolean;
  apiBaseUrl?: string;
};

type SubscribeCallbackArgs<
  TToken extends Realtime.Subscribe.Token = Realtime.Subscribe.Token,
> = {
  onMessage: Realtime.Subscribe.Callback<TToken>;
  onError?: (err: unknown) => void;
};

export function subscribe<
  const InputChannel extends Realtime.ChannelInput,
  const InputTopics extends ChannelTopicsInput<InputChannel>,
  const TToken extends Realtime.Subscribe.Token<InputChannel, InputTopics>,
  const TOutput extends Realtime.Subscribe.StreamSubscription<TToken>,
>(token: SubscribeBaseArgs<InputChannel, InputTopics>): Promise<TOutput>;
export function subscribe<
  const InputChannel extends Realtime.ChannelInput,
  const InputTopics extends ChannelTopicsInput<InputChannel>,
  const TToken extends Realtime.Subscribe.Token<InputChannel, InputTopics>,
>(
  token: SubscribeBaseArgs<InputChannel, InputTopics> &
    SubscribeCallbackArgs<TToken>,
): Promise<Realtime.Subscribe.CallbackSubscription>;
export function subscribe<
  const InputChannel extends Realtime.ChannelInput,
  const InputTopics extends ChannelTopicsInput<InputChannel>,
  const TToken extends Realtime.Subscribe.Token<InputChannel, InputTopics>,
  const TOutput extends Realtime.Subscribe.StreamSubscription<TToken>,
>(
  token: SubscribeBaseArgs<InputChannel, InputTopics>,
  callback?: Realtime.Subscribe.Callback<TToken>,
): Promise<TOutput>;
export async function subscribe<
  const InputChannel extends Realtime.ChannelInput,
  const InputTopics extends ChannelTopicsInput<InputChannel>,
  const TToken extends Realtime.Subscribe.Token<InputChannel, InputTopics>,
  const TOutput extends Realtime.Subscribe.StreamSubscription<TToken>,
>(
  token: SubscribeBaseArgs<InputChannel, InputTopics> &
    Partial<SubscribeCallbackArgs<TToken>>,
  callback?: Realtime.Subscribe.Callback<TToken>,
): Promise<TOutput | Realtime.Subscribe.CallbackSubscription> {
  const app: Inngest.Any | undefined = token.app as Inngest.Any | undefined;

  const getSubscriptionToken = app
    ? (channel: string, topics: string[]) =>
        (app as Inngest.Any)["inngestApi"].getSubscriptionToken(channel, topics)
    : undefined;

  const subscription = new TokenSubscription({
    token: token as Realtime.Subscribe.Token,
    apiBaseUrl: token.apiBaseUrl ?? app?.apiBaseUrl,
    getSubscriptionToken,
    validate: token.validate,
  });

  await subscription.connect();

  const extras = {
    getJsonStream: () => subscription.getJsonStream(),
    getEncodedStream: () => subscription.getEncodedStream(),
    close: (reason?: string) => subscription.close(reason),
    unsubscribe: (reason?: string) => subscription.close(reason),
  };

  const onMessage = token.onMessage || callback;
  if (onMessage) {
    const callbackStream = subscription.getJsonStream();
    subscription.useCallback(onMessage, callbackStream, token.onError);
  }

  if (token.onMessage) {
    return extras;
  }

  const retStream = subscription.getJsonStream();
  return Object.assign(retStream, extras) as unknown as TOutput;
}

export const getSubscriptionToken = async <
  const InputChannel extends Realtime.ChannelInput,
  const InputTopics extends ChannelTopicsInput<InputChannel>,
  const TToken extends Realtime.Subscribe.Token<InputChannel, InputTopics>,
>(
  app: Inngest.Like,
  args: {
    channel: InputChannel;
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
    channel: args.channel,
    topics: args.topics,
    key,
    apiBaseUrl: (app as Inngest.Any)?.apiBaseUrl,
  } as TToken;
};

export const getClientSubscriptionToken = async <
  const InputChannel extends Realtime.ChannelInput,
  const InputTopics extends ChannelTopicsInput<InputChannel>,
>(
  app: Inngest.Like,
  args: {
    channel: InputChannel;
    topics: InputTopics;
  },
): Promise<Realtime.Subscribe.ClientToken> => {
  const token = await getSubscriptionToken(app, args);

  if (!token.key) {
    throw new Error("No realtime subscription token key returned");
  }

  return {
    key: token.key,
    apiBaseUrl: token.apiBaseUrl,
  };
};
