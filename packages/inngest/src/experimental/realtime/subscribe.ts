import debug from "debug";
import { type Inngest } from "../../components/Inngest.js";
import { topic } from "./topic.js";
import { Realtime } from "./types.js";

/**
 * Map of token keys to active subscriptions.
 *
 * Used to map every token to a single connection and allowing subscribing and
 * unsubscribing to topics without creating new connections.
 */
const tokenSubscriptions = new Map<string, TokenSubscription>();

/**
 * TODO
 */
export const subscribe = async <
  const InputChannel extends
    | Realtime.Channel.Definition
    | Realtime.Channel
    | string,
  const InputTopics extends (keyof Realtime.Channel.InferTopics<
    Realtime.Channel.AsChannel<InputChannel>
  > &
    string)[] = (keyof Realtime.Channel.InferTopics<
    Realtime.Channel.AsChannel<InputChannel>
  > &
    string)[],
  const TToken extends Realtime.Subscribe.Token<
    Realtime.Channel.AsChannel<InputChannel>,
    InputTopics
  > = Realtime.Subscribe.Token<
    Realtime.Channel.AsChannel<InputChannel>,
    InputTopics
  >,
  const TOutput extends
    Realtime.Subscribe.StreamSubscription<TToken> = Realtime.Subscribe.StreamSubscription<TToken>,
>(
  /**
   * TODO
   */
  app: Inngest.Any,

  /**
   * TODO
   */
  token: {
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
  callback?: Realtime.Subscribe.Callback<TToken>
): Promise<TOutput> => {
  const subscription = new TokenSubscription(
    app,
    token as Realtime.Subscribe.Token
  );
  const iterator = subscription.getIterator(subscription.getStream());

  await subscription.connect();

  const extras = {
    close: () => subscription.close(),
    cancel: () => subscription.close(),
    getStream: () => subscription.getStream(),
  };

  if (callback) {
    subscription.useCallback(subscription.getStream(), callback);
  }

  return Object.assign(iterator, extras) as TOutput;
};

/**
 * TODO
 */
export const getSubscriptionToken = async <
  const InputChannel extends
    | Realtime.Channel.Definition
    | Realtime.Channel
    | string,
  const InputTopics extends (keyof Realtime.Channel.InferTopics<
    Realtime.Channel.AsChannel<InputChannel>
  > &
    string)[] = (keyof Realtime.Channel.InferTopics<
    Realtime.Channel.AsChannel<InputChannel>
  > &
    string)[],
  const TToken extends Realtime.Subscribe.Token<
    Realtime.Channel.AsChannel<InputChannel>,
    InputTopics
  > = Realtime.Subscribe.Token<
    Realtime.Channel.AsChannel<InputChannel>,
    InputTopics
  >,
>(
  /**
   * TODO
   */
  app: Inngest.Any,

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
  }
): Promise<TToken> => {
  const channelId =
    typeof args.channel === "string" ? args.channel : args.channel.name;

  if (!channelId) {
    throw new Error("Channel ID is required to create a subscription token");
  }

  const key = await app["inngestApi"].getSubscriptionToken(
    channelId,
    args.topics
  );

  const token = {
    channel: channelId,
    topics: args.topics,
    key,
  } as TToken;

  return token;
};

// Must be a new connection for every token used.
export class TokenSubscription {
  #debug = debug("inngest:realtime");

  #running = false;

  #sourceStreamContoller: ReadableStreamDefaultController | null = null;

  #sourceStream = new ReadableStream<Realtime.Message>({
    start: (controller) => {
      this.#sourceStreamContoller = controller;
    },
  });

  #createdStreamControllers = new Set<ReadableStreamDefaultController>();

  #ws: WebSocket | null = null;

  /**
   * A counter for the number of active subscriptions for each topic.
   * It contains all topics allowed by the token.
   * If the counter reaches 0, the topic is unsubscribed.
   */
  #topicsInUse: Map<string, number>;

  #channelId: string;
  #topics: Record<string, Realtime.Topic.Definition>;

  constructor(
    public app: Inngest.Any,
    public token: Realtime.Subscribe.Token
  ) {
    this.#topicsInUse = new Map<string, number>(
      this.token.topics.map((topic) => [topic, 0])
    );

    if (typeof token.channel === "string") {
      this.#channelId = token.channel;

      this.#topics = this.token.topics.reduce<
        Record<string, Realtime.Topic.Definition>
      >((acc, name) => {
        acc[name] = topic(name);

        return acc;
      }, {});
    } else {
      this.#channelId = token.channel.name;

      this.#topics = this.token.topics.reduce<
        Record<string, Realtime.Topic.Definition>
      >((acc, name) => {
        acc[name] = token.channel.topics[name] ?? topic(name);

        return acc;
      }, {});
    }
  }

  public async connect() {
    this.#debug(
      `Establishing connection to channel "${
        this.#channelId
      }" with topics ${JSON.stringify(this.#topics)}...`
    );

    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    const key =
      this.token.key || (await getSubscriptionToken(this.app, this.token)).key;
    if (!key) {
      throw new Error(
        "No subscription token key passed and failed to retrieve one automatically"
      );
    }

    this.#ws = new WebSocket(
      `ws://127.0.0.1:8288/v1/realtime/connect?token=${key}`
    );

    this.#ws.onopen = () => {
      this.#debug("WebSocket connection established");
    };

    this.#ws.onmessage = async (event) => {
      const {
        success,
        data: msg,
        error: err,
      } = await Realtime.messageSchema.safeParseAsync(
        JSON.parse(event.data as string)
      );

      if (!success) {
        this.#debug("Received invalid message:", err);
        return;
      }

      if (!this.#running) {
        this.#debug(
          `Received message on channel "${msg.channel}" for topic "${msg.topic}" but stream is closed`
        );
      }

      const userlandMessageKinds: Realtime.Message["kind"][] = ["data"];

      // TODO What kind of messages do we care about?
      if (userlandMessageKinds.includes(msg.kind)) {
        const topic = this.#topics[msg.topic];
        if (!topic) {
          this.#debug(
            `Received message on channel "${msg.channel}" for unknown topic "${msg.topic}"`
          );
          return;
        }

        const schema = topic.getSchema();
        if (schema) {
          try {
            msg.data = await schema["~standard"].validate(msg.data);
          } catch (err) {
            this.#debug(
              `Received message on channel "${msg.channel}" for topic "${msg.topic}" that failed schema validation:`,
              err
            );
            return;
          }
        }

        this.#debug(
          `Received message on channel "${msg.channel}" for topic "${msg.topic}":`,
          msg.data
        );

        this.#sourceStreamContoller?.enqueue(event.data);
      }
    };

    this.#ws.onerror = (event) => {
      console.error("WebSocket error observed:", event);
    };

    this.#ws.onclose = (event) => {
      this.#debug("WebSocket closed:", event.reason);
      this.close();
    };

    this.#running = true;

    void (async () => {
      const reader = this.#sourceStream.getReader();

      while (this.#running) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        for (const controller of this.#createdStreamControllers) {
          controller.enqueue(value);
        }
      }
    })();
  }

  public close(reason: string = "Userland closed connection") {
    if (!this.#running) {
      return;
    }

    this.#debug("close() called; closing connection...");
    this.#running = false;
    this.#ws?.close(1000, reason);

    this.#debug(`Closing ${this.#createdStreamControllers.size} streams...`);
    this.#sourceStreamContoller?.close();
    this.#createdStreamControllers.forEach((controller) => controller.close());
  }

  public getStream() {
    let controller: ReadableStreamDefaultController;

    const stream = new ReadableStream<Realtime.Message>({
      start: (_controller) => {
        controller = _controller;
        this.#createdStreamControllers.add(controller);
      },

      cancel: () => {
        this.#createdStreamControllers.delete(controller);
      },
    });

    return stream;
  }

  public getIterator(stream: ReadableStream<Realtime.Message>) {
    return {
      [Symbol.asyncIterator]: () => {
        const reader = stream.getReader();

        return {
          next: () => {
            return reader.read();
          },

          return: () => {
            reader.releaseLock();
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }

  public useCallback(
    stream: ReadableStream<Realtime.Message>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: Realtime.Subscribe.Callback<any>
  ) {
    void (async () => {
      const reader = stream.getReader();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        callback(value);
      }
    })();
  }
}
