import { type StandardSchemaV1 } from "@standard-schema/spec";
import { type IsStringLiteral, type Simplify } from "../../helpers/types.js";

export namespace Realtime {
  export type PublishFn = <TMessage extends Realtime.Message.Input>(
    message: TMessage
  ) => Promise<TMessage["data"]>;

  export type SubscribeFn = <
    TSubscribeToken extends Subscribe.Token,
    TCallback extends
      | Subscribe.Callback<TSubscribeToken>
      | undefined = undefined,
  >(
    token: TSubscribeToken,
    callback?: TCallback
  ) => Promise<
    TCallback extends undefined
      ? Subscribe.StreamSubscription<TSubscribeToken>
      : Subscribe.CallbackSubscription
  >;

  export namespace Subscribe {
    // TODO Allow warm/cold?
    export type CallbackSubscription = () => void;

    export type StreamSubscription<
      TSubscribeToken extends Token = Token,
      TData extends
        Token.InferMessage<TSubscribeToken> = Token.InferMessage<TSubscribeToken>,
    > = ReadableStream<TData> & {
      [Symbol.asyncIterator](): AsyncIterableIterator<TData>;

      /**
       * Warm close.
       */
      close(): Promise<void>;

      /**
       * Cold close.
       */
      cancel(): void;

      /**
       * Get a new readable stream from the subscription.
       *
       * The stream starts when this function is called and will not contain any
       * messages that were sent before this function was called.
       */
      getStream(): ReadableStream<TData>;
    };

    export type Callback<
      TSubscribeToken extends Subscribe.Token = Subscribe.Token,
    > = (message: Token.InferMessage<TSubscribeToken>) => void;

    export type Token<
      TChannel extends Channel = Channel,
      TTopics extends
        (keyof Channel.InferTopics<TChannel>)[] = (keyof Channel.InferTopics<TChannel>)[],
    > = {
      // key used to auth - could be undefined as then we can do a cold subscribe
      key?: Promise<string> | undefined;
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

      export type InferMessage<TToken extends Token> = Realtime.Message<
        TToken["channel"],
        Token.InferTopicData<TToken>
      >;
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
      topics: [K]; // Odd - should be `topic` instead of `topics`? Data leak?
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
    > = {
      channel: TChannelId;
      topic: TTopicId;
      data: TData;
    };
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
