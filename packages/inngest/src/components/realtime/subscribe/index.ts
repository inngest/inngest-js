import type { Inngest } from "../../Inngest.ts";
import type { Realtime } from "../types.ts";
import { TokenSubscription } from "./TokenSubscription.ts";

type SubscribeBaseArgs<
  InputChannel extends Realtime.Channel | string,
  InputTopics extends (keyof Realtime.Channel.InferTopics<
    Realtime.Channel.AsChannel<InputChannel>
  > &
    string)[],
> = {
  app?: Inngest.Like;
  key?: string;
  channel: Realtime.Subscribe.InferChannelInput<InputChannel>;
  topics: InputTopics;
  validate?: boolean;
};

type SubscribeCallbackArgs<
  TToken extends Realtime.Subscribe.Token = Realtime.Subscribe.Token,
> = {
  onMessage: Realtime.Subscribe.Callback<TToken>;
  onError?: (err: unknown) => void;
};

export function subscribe<
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
  token: SubscribeBaseArgs<InputChannel, InputTopics>,
): Promise<TOutput>;
export function subscribe<
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
  token: SubscribeBaseArgs<InputChannel, InputTopics> &
    SubscribeCallbackArgs<TToken>,
): Promise<Realtime.Subscribe.CallbackSubscription>;
export function subscribe<
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
  token: SubscribeBaseArgs<InputChannel, InputTopics>,
  callback?: Realtime.Subscribe.Callback<TToken>,
): Promise<TOutput>;
export async function subscribe<
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
    apiBaseUrl: app?.apiBaseUrl,
    getSubscriptionToken,
    validate: token.validate,
  });

  const retStream = subscription.getJsonStream();
  const callbackStream = subscription.getJsonStream();

  await subscription.connect();

  const extras = {
    getJsonStream: () => subscription.getJsonStream(),
    getEncodedStream: () => subscription.getEncodedStream(),
    close: (reason?: string) => subscription.close(reason),
    unsubscribe: (reason?: string) => subscription.close(reason),
  };

  const onMessage = token.onMessage || callback;
  if (onMessage) {
    subscription.useCallback(onMessage, callbackStream, token.onError);
  } else {
    callbackStream.cancel("Not needed");
  }

  if (token.onMessage) {
    retStream.cancel("Callback subscription doesn't expose a stream");
    return extras;
  }

  return Object.assign(retStream, extras) as unknown as TOutput;
}

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
