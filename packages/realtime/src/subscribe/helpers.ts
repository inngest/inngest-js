import type { Inngest } from "inngest";
import { getEnvVar } from "../env";
import type { Realtime } from "../types";
import { TokenSubscription } from "./TokenSubscription";

/**
 * TODO
 */
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
  /**
   * TODO
   */
  token: {
    /**
     * TODO
     */
    app?: Inngest.Like;

    /**
     * TODO
     */
    channel: Realtime.Subscribe.InferChannelInput<InputChannel>;

    /**
     * TODO
     */
    topics: InputTopics;
  },

  /**
   * TODO
   */
  callback?: Realtime.Subscribe.Callback<TToken>,
): Promise<TOutput> => {
  const app: Inngest.Any | undefined = token.app as Inngest.Any | undefined;
  const api: { signingKey?: string; signingKeyFallback?: string } | undefined =
    app?.["inngestApi"];

  // Allow users to specify public env vars for the target URLs, but do not
  // allow this for signing keys, as they should never be on a client.
  const maybeApiBaseUrl =
    app?.apiBaseUrl ||
    getEnvVar("INNGEST_BASE_URL") ||
    getEnvVar("INNGEST_API_BASE_URL");

  const maybeSigningKey =
    api?.["signingKey"] || getEnvVar("INNGEST_SIGNING_KEY");

  const maybeSigningKeyFallback =
    api?.["signingKeyFallback"] || getEnvVar("INNGEST_SIGNING_KEY_FALLBACK");

  const subscription = new TokenSubscription(
    token as Realtime.Subscribe.Token,
    maybeApiBaseUrl,
    maybeSigningKey,
    maybeSigningKeyFallback,
  );

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

/**
 * TODO
 */
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
  /**
   * TODO
   */
  app: Inngest.Like,

  /**
   * TODO
   */
  args: {
    /**
     * TODO
     */
    channel: Realtime.Subscribe.InferChannelInput<InputChannel>;

    /**
     * TODO
     */
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

  const token = {
    channel: channelId,
    topics: args.topics,
    key,
  } as TToken;

  return token;
};
