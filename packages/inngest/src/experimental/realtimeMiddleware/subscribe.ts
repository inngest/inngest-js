import debug from "debug";
import EventEmitter from "node:events";
import { type Realtime } from "./types.js";

/**
 * Map of token keys to active subscriptions.
 *
 * Used to map every token to a single connection and allowing subscribing and
 * unsubscribing to topics without creating new connections.
 */
const tokenSubscriptions = new Map<string, TokenSubscription>();

export const getSubscribeToken: Realtime.Subscribe.TokenFn = async () => {};

export const subscribe: Realtime.SubscribeFn = async (token, callback) => {
  const subscription = new TokenSubscription(token);
  const stream = subscription.getStream();

  await subscription.connect();

  const extras = {
    close: () => subscription.close(),
    cancel: () => subscription.close(),
    getStream: () => subscription.getStream(),
  };

  if (callback) {
    subscription.useCallback(stream, callback);

    return Object.assign(() => {
      subscription.close();
    }, extras);
  }

  console.log("returning an iterator");

  return Object.assign(subscription.getIterator(stream), extras);
};

// Must be a new connection for every token used.
class TokenSubscription {
  #debug = debug("inngest:realtime");

  #running = false;

  #sourceStreamContoller: ReadableStreamDefaultController | null = null;

  #sourceStream = new ReadableStream<Realtime.Message>({
    start: (controller) => {
      this.#sourceStreamContoller = controller;
    },
  });

  #createdStreamControllers = new Set<ReadableStreamDefaultController>();

  /**
   * A counter for the number of active subscriptions for each topic.
   * It contains all topics allowed by the token.
   * If the counter reaches 0, the topic is unsubscribed.
   */
  #topicsInUse: Map<string, number>;

  constructor(public token: Realtime.Subscribe.Token) {
    this.#topicsInUse = new Map<string, number>(
      this.token.topics.map((topic) => [topic, 0])
    );
  }

  public async connect() {
    this.#debug(
      `Establishing connection to channel "${
        this.token.channel
      }" with topics "${this.token.topics.join(", ")}"`
    );

    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    // .. connect and then
    const ws = new EventEmitter();
    ws.on("message", (data) => {
      if (this.#running) {
        this.#sourceStreamContoller?.enqueue(data);
      }
    });

    // Fake traffic
    setInterval(() => {
      ws.emit("message", { data: "Hello" });
    }, 1000);

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

  public close() {
    this.#running = false;
    this.#sourceStreamContoller?.close();
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
    callback: (message: Realtime.Message) => void
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
