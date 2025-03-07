import { type StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import {
  type Expect,
  type IsEqual,
  type IsLiteral,
  type IsStringLiteral,
  type MaybePromise,
  type Simplify,
} from "../../helpers/types.js";

export namespace Realtime {
  export type PublishFn = <
    TMessage extends MaybePromise<Realtime.Message.Input>,
  >(
    message: TMessage
  ) => Promise<Awaited<TMessage>["data"]>;

  export namespace Subscribe {
    export type InferChannelInput<T> = T extends Realtime.Channel.Definition
      ? Realtime.Channel.Definition.InferId<T>
      : T;

    export type StreamSubscription<
      TSubscribeToken extends Token = Token,
      TData extends Simplify<Token.InferMessage<TSubscribeToken>> = Simplify<
        Token.InferMessage<TSubscribeToken>
      >,
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
      channel: TChannel | Channel.InferId<TChannel>;
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
        Channel.InferId<Token.InferChannel<TToken>>,
        Token.InferTopicData<TToken>
      >;
    }
  }

  // We need to use a `Message` type so that we can appropriately type incoming
  // and outgoing messages with generics, but we also need to validate these at
  // runtime.
  //
  // Ideally in the future we use protobuf for this, but for now we use Zod.
  // This type is used to assert that the Zod schema matches the generic type.
  type _AssertMessageSchemaMatchesGeneric = Expect<
    IsEqual<z.output<typeof messageSchema>, Message>
  >;

  export const messageSchema = z
    .object({
      channel: z.string(),
      topic: z.string(),
      data: z.any(),
      run_id: z.string(),
      fn_id: z.string(),
      created_at: z.string().transform((v) => new Date(v)),
      env_id: z.string(),
      kind: z.enum(["step", "run", "data", "ping", "pong", "closing"]),
    })
    .transform(({ data, ...rest }) => {
      return {
        ...rest,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: data ?? undefined,
      };
    });

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
      run_id: string;
      fn_id: string;
      created_at: Date;
      env_id: string;
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
    [K in
      | IsLiteral<keyof TTopics, keyof TTopics, never>
      | "name"
      | "topics"]: K extends "name"
      ? string
      : K extends "topics"
        ? TTopics
        : Realtime.Topic<TChannelId, TTopics[K]>;
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

    export type AsChannel<T extends Channel.Definition | Channel | string> =
      T extends Channel.Definition
        ? Realtime.Channel<
            Realtime.Channel.Definition.InferId<T>,
            Realtime.Channel.Definition.InferTopics<T>
          >
        : T extends Channel
          ? T
          : T extends string
            ? Realtime.Channel<T>
            : never;

    export type InferTopics<
      TChannel extends Channel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    > = TChannel extends Channel.Definition<any, infer ITopics>
      ? ITopics
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        TChannel extends Channel<any, infer ITopics>
        ? ITopics
        : Record<string, Realtime.Topic.Definition>;

    export interface Definition<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TChannelBuilderFn extends BuilderFn = (...args: any[]) => string,
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

      topics: TTopics;
    }

    export namespace Definition {
      export type InferId<TChannel extends Definition> =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        TChannel extends Definition<infer IBuilder, any>
          ? ReturnType<IBuilder>
          : string;

      export type InferTopics<TChannel extends Definition> =
        TChannel extends Definition<
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          any,
          infer ITopics
        >
          ? ITopics
          : Record<string, Topic.Definition>;
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
  ) => Promise<
    Realtime.Message.Input<
      TChannelId,
      Topic.InferId<TTopic>,
      Topic.InferPublish<TTopic>
    >
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

      getSchema(): StandardSchemaV1 | undefined;
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
