import { type StandardSchemaV1 } from "@standard-schema/spec";
import { type InngestApi } from "../api/api.js";
import { getAsyncCtx } from "../components/execution/als.js";
import { InngestMiddleware } from "../components/InngestMiddleware.js";
import { type IsStringLiteral, type Simplify } from "../helpers/types.js";

export const channel: Realtime.Channel.Builder = (id) => {};

export const topic: Realtime.Topic.Builder = (id) => {};

// Batches by channel internally
export const publish: Realtime.PublishFn = async () => {};

export const subscribeToken: Realtime.Subscribe.TokenFn = async () => {};

export const subscribe: Realtime.SubscribeFn = () => {};

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

export namespace Realtime {
  export type PublishFn = (message: Realtime.Message.Input) => Promise<void>;

  export type SubscribeFn = <TSubscribeToken extends Subscribe.Token>(
    token: TSubscribeToken,
    callback: (
      message: Realtime.Message<
        TSubscribeToken["channel"],
        Subscribe.Token.InferTopicData<TSubscribeToken>
      >
    ) => void
  ) => void;

  export namespace Subscribe {
    export type Token<
      TChannel extends Channel = Channel,
      TTopics extends
        (keyof Channel.InferTopics<TChannel>)[] = (keyof Channel.InferTopics<TChannel>)[],
    > = {
      // key used to auth
      key: Promise<string>;
      channel: Channel.InferId<TChannel>;
      topics: TTopics;
    };

    export namespace Token {
      export type InferChannel<TToken extends Token> = TToken extends Token<
        infer IChannel,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        any
      >
        ? IChannel
        : Channel;

      export type InferTopicData<
        TToken extends Token,
        TChannelTopics extends Record<
          string,
          Topic.Definition
        > = Channel.InferTopics<Token.InferChannel<TToken>>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      > = TToken extends Token<any, infer ITopics>
        ? { [K in ITopics[number]]: TChannelTopics[K] }
        : never;
    }

    export type TokenFn = <
      const TChannel extends Channel,
      const TTopics extends (keyof Channel.InferTopics<TChannel>)[],
    >(args: {
      channel: TChannel;
      topics: TTopics;
    }) => Token<TChannel, TTopics>;
  }

  // Subscribe (output) msg
  export type Message<
    TChannelId extends string = string,
    TTopics extends Record<string, Realtime.Topic.Definition> = Record<
      string,
      Realtime.Topic.Definition
    >,
  > = {
    [K in keyof TTopics]: {
      topic: K;
      data: Realtime.Topic.InferSubscribe<TTopics[K]>;
      channel: TChannelId;

      metadata: {
        run_id: string;
        fn_id: string;
        fn_slug: string;
        created_at: string;
      };

      kind:
        | "step" // step data
        | "run" // run results
        | "data" // misc stream data from `ctx.publish()`
        | "ping" // keepalive server -> client
        | "pong" // keepalive client -> server
        | "closing"; // server is closing connection, client should reconnect
      // | "event" // event sent to inngest
    };
  }[keyof TTopics];

  export namespace Message {
    // Publish (input) msg
    export type Input<
      TChannelId extends string = string,
      TTopicId extends string = string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TData = any,
    > = Simplify<{
      channel: TChannelId;
      topic: TTopicId;
      data: TData;
    }>;
  }

  export type Channel<
    TChannelId extends string = string,
    TTopics extends Record<string, Realtime.Topic.Definition> = Record<
      string,
      Realtime.Topic.Definition
    >,
  > = {
    [K in keyof TTopics]: Realtime.Topic<TChannelId, TTopics[K]>;
  };

  export namespace Channel {
    export type Like = {
      channel: string;
      topics: string[];
    };

    export type InferId<TChannel extends Channel> = TChannel extends Channel<
      infer IId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >
      ? IId
      : string;

    export type InferTopics<TChannel extends Channel> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TChannel extends Channel<any, infer ITopics>
        ? ITopics
        : Record<string, Realtime.Topic.Definition>;

    export interface Definition<
      TChannelBuilderFn extends BuilderFn = () => string,
      TTopics extends Record<string, Topic.Definition> = Record<
        string,
        Topic.Definition
      >,
    > {
      (
        ...args: Parameters<TChannelBuilderFn>
      ): Channel<ReturnType<TChannelBuilderFn>, TTopics>;

      addTopic<UTopic extends Topic.Definition>(
        topic: UTopic
      ): Definition<TChannelBuilderFn, AddTopic<TTopics, UTopic>>;
    }

    export type AddTopic<
      TCurr extends Record<string, Topic.Definition>,
      TInc extends Topic.Definition,
      TIncWrapped extends Record<TInc["name"], TInc> = Record<
        TInc["name"],
        TInc
      >,
    > = IsStringLiteral<keyof TCurr & string> extends true
      ? Simplify<Omit<TCurr, TInc["name"]> & TIncWrapped>
      : TIncWrapped;

    export type BuilderFn<TChannelId extends string = string> = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...args: any[]
    ) => TChannelId;

    export type Builder = <
      const TChannelId extends string,
      const TIdInput extends TChannelId | BuilderFn<TChannelId>,
    >(
      id: TIdInput
    ) => TIdInput extends TChannelId
      ? Channel.Definition<() => TIdInput>
      : TIdInput extends BuilderFn<TChannelId>
        ? Channel.Definition<TIdInput>
        : never;
  }

  export type Topic<
    TChannelId extends string = string,
    TTopic extends Topic.Definition = Topic.Definition,
  > = (
    data: Topic.InferPublish<TTopic>
  ) => Realtime.Message.Input<
    TChannelId,
    Topic.InferId<TTopic>,
    Topic.InferPublish<TTopic>
  >;

  export namespace Topic {
    export type Like = {
      name: string;
    };

    export interface Definition<
      TTopicId extends string = string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TPublish = any,
      _TSubscribe = TPublish,
    > {
      name: TTopicId;

      type<const UPublish, const USubscribe = UPublish>(): Definition<
        TTopicId,
        UPublish,
        USubscribe
      >;

      schema<const TSchema extends StandardSchemaV1>(
        schema: TSchema
      ): Definition<
        TTopicId,
        StandardSchemaV1.InferInput<TSchema>,
        StandardSchemaV1.InferOutput<TSchema>
      >;
    }

    export type InferId<TTopic extends Topic.Definition> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TTopic extends Topic.Definition<infer IId, any, any> ? IId : string;

    export type InferPublish<TTopic extends Topic.Definition> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TTopic extends Topic.Definition<any, infer IPublish, any>
        ? IPublish
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          any;

    export type InferSubscribe<TTopic extends Topic.Definition> =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TTopic extends Topic.Definition<any, any, infer ISubscribe>
        ? ISubscribe
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          any;

    export type Builder = <const TTopicId extends string>(
      id: TTopicId
    ) => Topic.Definition<TTopicId>;
  }
}
