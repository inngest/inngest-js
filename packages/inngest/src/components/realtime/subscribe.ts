import debug from "debug";
import { type Inngest } from "../Inngest.js";
import { type Realtime } from "./types.js";

/**
 * Map of token keys to active subscriptions.
 *
 * Used to map every token to a single connection and allowing subscribing and
 * unsubscribing to topics without creating new connections.
 */
const tokenSubscriptions = new Map<string, TokenSubscription>();

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

  constructor(
    public app: Inngest.Any,
    public token: Realtime.Subscribe.Token
  ) {
    this.#topicsInUse = new Map<string, number>(
      this.token.topics.map((topic) => [topic, 0])
    );
  }

  public async connect() {
    this.#debug(
      `Establishing connection to channel "${
        this.token.channel
      }" with topics ${JSON.stringify(this.token.topics)}...`
    );

    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    const key = this.token.key ?? this.app.getSubscriptionToken(this.token).key;
    if (!key) {
      throw new Error(
        "No subscription token key passed and failed to retrieve one automatically"
      );
    }

    this.#ws = new WebSocket(
      `ws://127.0.0.1:8288/v1/realtime/connect?token=${await key}`
    );

    this.#ws.onopen = () => {
      this.#debug("WebSocket connection established");
    };

    this.#ws.onmessage = (event) => {
      // TODO parse
      const msg = JSON.parse(event.data as string) as Realtime.Message;

      // TODO Bad fix - message should only contain `topic` instead of `topics`
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      msg.topic = (msg as any).topics[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      delete (msg as any).topics;

      if (this.#running) {
        // TODO Should we be receiving `topics` here instead of `topic`? Data leak?
        this.#debug(
          `Received message on channel "${msg.channel}" for topic "${msg.topic}":`,
          msg.data
        );

        this.#sourceStreamContoller?.enqueue(event.data);
      } else {
        this.#debug(
          `Received message on channel "${msg.channel}" for topic "${msg.topic}" but stream is closed`
        );
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
