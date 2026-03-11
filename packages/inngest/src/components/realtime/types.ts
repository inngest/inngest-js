import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod/v3";

export namespace Realtime {
  export type ChannelInput = string | Realtime.ChannelInstance;

  export namespace Subscribe {
    export interface Token<
      TChannel extends Realtime.ChannelInput = Realtime.ChannelInput,
      TTopics extends string[] = string[],
    > {
      // key used to auth - could be undefined as then we can do a cold subscribe
      key?: string | undefined;
      channel: TChannel;
      topics: TTopics;
    }

    export type InferTopicSubscribeData<TTopic> =
      TTopic extends Realtime.TopicConfig
        ? Realtime.InferTopicData<TTopic>
        : // biome-ignore lint/suspicious/noExplicitAny: fallback for untyped topics
          any;

    export type StreamSubscription<
      TSubscribeToken extends Token = Token,
      TData extends Simplify<Token.InferMessage<TSubscribeToken>> = Simplify<
        Token.InferMessage<TSubscribeToken>
      >,
    > = ReadableStream<TData> & {
      /**
       * Get a new readable stream from the subscription that delivers JSON chunks.
       *
       * The stream starts when this function is called and will not contain any
       * messages that were sent before this function was called.
       */
      getJsonStream(): ReadableStream<TData>;

      /**
       * Get a new readable stream from the subscription that delivers
       * SSE-compatible chunks, which are compatible with the `EventSource` API
       * and generally used for streaming data from a server to the browser.
       *
       * The stream starts when this function is called and will not contain any
       * messages that were sent before this function was called.
       */
      getEncodedStream(): ReadableStream<Uint8Array>;

      /**
       * Close the underlying subscription connection.
       */
      close(reason?: string): void;

      /**
       * Alias for `close()` to match callback-style subscription semantics.
       */
      unsubscribe(reason?: string): void;
    };

    export type Callback<
      TSubscribeToken extends Subscribe.Token = Subscribe.Token,
    > = (message: Token.InferMessage<TSubscribeToken>) => MaybePromise<void>;

    export type CallbackSubscription = {
      close(reason?: string): void;
      unsubscribe(reason?: string): void;
    };

    export namespace Token {
      export type InferChannel<TToken extends Token> = TToken extends Token<
        infer IChannel,
        // biome-ignore lint/suspicious/noExplicitAny: fine in this generic
        any
      >
        ? IChannel
        : Realtime.ChannelInput;

      export type InferTopicData<
        TToken extends Token,
        TChannelTopics extends Record<string, unknown> = Channel.InferTopics<
          Token.InferChannel<TToken>
        >,
        // biome-ignore lint/suspicious/noExplicitAny: untargeted infer
      > = TToken extends Token<any, infer ITopics>
        ? { [K in ITopics[number]]: TChannelTopics[K] }
        : never;

      export type InferMessage<TToken extends Token> = Simplify<
        Realtime.Message<
          Channel.InferId<Token.InferChannel<TToken>>,
          Token.InferTopicData<TToken>
        >
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
    IsEqual<z.output<typeof messageSchema>, Message.Raw>
  >;

  export const messageSchema = z
    .object({
      channel: z.string().optional(),
      topic: z.string().optional(),
      data: z.any(),
      run_id: z.string().optional(),
      fn_id: z.string().optional(),
      created_at: z
        .string()
        .optional()
        .transform((v) => (v ? new Date(v) : undefined)),

      env_id: z.string().optional(),
      stream_id: z.string().optional(),
      kind: z.enum([
        "step",
        "run",
        "data",
        "ping",
        "pong",
        "closing",
        "event",
        "sub",
        "unsub",
        "datastream-start",
        "datastream-end",
        "chunk",
      ]),
    })
    .transform(({ data, ...rest }) => {
      return {
        ...rest,
        data: data ?? undefined,
      };
    });

  // Subscribe (output) msg
  export type Message<
    TChannelId extends string = string,
    TTopics extends Record<string, unknown> = Record<string, unknown>,
  > =
    | {
        [K in keyof TTopics]:
          | {
              topic: K;
              channel: TChannelId;
              data: Subscribe.InferTopicSubscribeData<TTopics[K]>;
              runId?: string;
              fnId?: string;
              createdAt: Date;
              envId?: string;
              kind: "data";
            }
          | {
              topic: K;
              channel: TChannelId;
              data: Subscribe.InferTopicSubscribeData<TTopics[K]>;
              runId?: string;
              fnId?: string;
              kind: "datastream-start" | "datastream-end" | "chunk";
              streamId: string;
              stream: ReadableStream<
                Subscribe.InferTopicSubscribeData<TTopics[K]>
              >;
            };
      }[keyof TTopics]
    | {
        channel?: TChannelId;
        topic?: string;
        data: unknown;
        runId?: string;
        fnId?: string;
        createdAt: Date;
        envId?: string;
        kind: "run";
      };

  export namespace Message {
    // Publish (input) msg
    export type Input<
      TChannelId extends string = string,
      TTopicId extends string = string,
      // biome-ignore lint/suspicious/noExplicitAny: data can be anything
      TData = any,
    > = {
      channel: TChannelId;
      topic: TTopicId;
      data: TData;
    };

    export type Raw<
      TChannelId extends string = string,
      TTopics extends Record<string, unknown> = Record<string, unknown>,
    > = {
      [K in keyof TTopics]: {
        topic?: K;
        stream_id?: string;
        data: Subscribe.InferTopicSubscribeData<TTopics[K]>;
        channel?: TChannelId;
        run_id?: string;
        fn_id?: string;
        created_at?: Date;
        env_id?: string;
        kind:
          | "step" // step data
          | "run" // run results
          | "data" // misc stream data from `inngest.publish()`
          | "datastream-start"
          | "datastream-end"
          | "ping" // keepalive server -> client
          | "pong" // keepalive client -> server
          | "closing" // server is closing connection, client should reconnect
          | "event" // event sent to inngest
          | "sub"
          | "unsub"
          | "chunk";
      };
    }[keyof TTopics];
  }

  export namespace Channel {
    export type InferId<
      TChannel extends Realtime.ChannelInstance | Realtime.ChannelDef | string,
    > = TChannel extends Realtime.ChannelInstance<
      infer IId,
      Realtime.TopicsConfig
    >
      ? IId
      : TChannel extends Realtime.ChannelDef<
            infer TNameFn,
            Realtime.TopicsConfig
          >
        ? ReturnType<TNameFn>
        : TChannel extends string
          ? TChannel
          : string;

    export type InferTopics<
      TChannel extends Realtime.ChannelInstance | Realtime.ChannelDef | string,
    > = TChannel extends Realtime.ChannelDef<infer _NameFn, infer ITopics>
      ? ITopics
      : TChannel extends Realtime.ChannelInstance<infer _Name, infer ITopics>
        ? ITopics
        : TChannel extends string
          ? Record<string, unknown>
          : Record<string, unknown>;
  }

  //
  // A TopicConfig is one entry in a channel's `topics` record.
  // Always uses `{ schema }` — for type-only topics, use staticSchema<T>()
  // which returns a passthrough Standard Schema with zero validation cost.
  export type TopicConfig = { schema: StandardSchemaV1 };

  export type TopicsConfig = Record<string, TopicConfig>;

  export type InferTopicData<T extends TopicConfig> = T extends {
    schema: infer S extends StandardSchemaV1;
  }
    ? StandardSchemaV1.InferInput<S>
    : unknown;

  //
  // A TopicRef is a lightweight value carrying the resolved channel name,
  // topic name, topic config, and payload type. Created by dot-accessing
  // a topic on a channel instance (e.g. `chat.status`).
  export interface TopicRef<_TData = unknown> {
    channel: string;
    topic: string;
    config: TopicConfig;
  }

  //
  // Maps a TopicsConfig into dot-access topic accessors that return TopicRefs.
  export type TopicAccessors<
    _TName extends string,
    TTopics extends TopicsConfig,
  > = {
    [K in string & keyof TTopics]: TopicRef<InferTopicData<TTopics[K]>>;
  };

  export type ChannelInstance<
    TName extends string = string,
    TTopics extends TopicsConfig = {},
  > = {
    name: TName;
    topics: TTopics;
  } & TopicAccessors<TName, TTopics>;

  export type ChannelDef<
    // biome-ignore lint/suspicious/noExplicitAny: broad fn definition
    TNameFn extends (...args: any[]) => string = (...args: any[]) => string,
    TTopics extends TopicsConfig = TopicsConfig,
  > = ((
    ...args: Parameters<TNameFn>
  ) => ChannelInstance<ReturnType<TNameFn>, TTopics>) & {
    topics: TTopics;
    $params: Parameters<TNameFn>[0];
  };

  //
  // publish(topicRef, data) — two-arg form using topic accessors
  export type TypedPublishFn = <TData>(
    topicRef: TopicRef<TData>,
    data: TData,
  ) => Promise<void>;
}

/**
 * Expects that a value resolves to `true`, useful for asserting type checks.
 */
export type Expect<T extends true> = T;

/**
Returns a boolean for whether the two given types are equal.

{@link https://github.com/microsoft/TypeScript/issues/27024#issuecomment-421529650}
{@link https://stackoverflow.com/questions/68961864/how-does-the-equals-work-in-typescript/68963796#68963796}

Use-cases:
- If you want to make a conditional branch based on the result of a comparison of two types.

@example
```
import type {IsEqual} from 'type-fest';

// This type returns a boolean for whether the given array includes the given item.
// `IsEqual` is used to compare the given array at position 0 and the given item and then return true if they are equal.
type Includes<Value extends readonly any[], Item> =
	Value extends readonly [Value[0], ...infer rest]
		? IsEqual<Value[0], Item> extends true
			? true
			: Includes<rest, Item>
		: false;
```
*/
export type IsEqual<A, B> = (<G>() => G extends A ? 1 : 2) extends <
  G,
>() => G extends B ? 1 : 2
  ? true
  : false;

/**
 * Returns the given generic as either itself or a promise of itself.
 */
export type MaybePromise<T> = T | Promise<T>;

export type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};
