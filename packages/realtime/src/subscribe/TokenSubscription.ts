import debug from "debug";
import { api } from "../api";
import { topic } from "../topic";
import { Realtime } from "../types";
import {
  createDeferredPromise,
  getPublicEnvVar,
  parseAsBoolean,
} from "../util";
import { StreamFanout } from "./StreamFanout";

/**
 * TODO
 */
export class TokenSubscription {
  #apiBaseUrl?: string;
  #channelId: string;
  #debug = debug("inngest:realtime");
  #encoder = new TextEncoder();
  #fanout = new StreamFanout<Realtime.Message>();
  #running = false;
  #topics: Map<string, Realtime.Topic.Definition>;
  #ws: WebSocket | null = null;
  #signingKey: string | undefined;
  #signingKeyFallback: string | undefined;

  /**
   * This is a map that tracks stream IDs to their corresponding streams and
   * controllers.
   */
  #chunkStreams = new Map<
    string,
    { stream: ReadableStream; controller: ReadableStreamDefaultController }
  >();

  constructor(
    /**
     * TODO
     */
    public token: Realtime.Subscribe.Token,
    apiBaseUrl: string | undefined,
    signingKey: string | undefined,
    signingKeyFallback: string | undefined,
  ) {
    this.#apiBaseUrl = apiBaseUrl;
    this.#signingKey = signingKey;
    this.#signingKeyFallback = signingKeyFallback;

    if (typeof token.channel === "string") {
      this.#channelId = token.channel;

      this.#topics = this.token.topics.reduce<
        Map<string, Realtime.Topic.Definition>
      >((acc, name) => {
        acc.set(name, topic(name));

        return acc;
      }, new Map<string, Realtime.Topic.Definition>());
    } else {
      this.#channelId = token.channel.name;

      this.#topics = this.token.topics.reduce<
        Map<string, Realtime.Topic.Definition>
      >((acc, name) => {
        acc.set(name, token.channel.topics[name] ?? topic(name));

        return acc;
      }, new Map<string, Realtime.Topic.Definition>());
    }
  }

  private async getWsUrl(token: string): Promise<URL> {
    let url: URL;
    const path = "/v1/realtime/connect";
    const devEnvVar = getPublicEnvVar("INNGEST_DEV");

    if (this.#apiBaseUrl) {
      url = new URL(path, this.#apiBaseUrl);
    } else if (devEnvVar) {
      try {
        const devUrl = new URL(devEnvVar);
        url = new URL(path, devUrl);
      } catch {
        if (parseAsBoolean(devEnvVar)) {
          url = new URL(path, "http://localhost:8288/");
        } else {
          url = new URL(path, "https://api.inngest.com/");
        }
      }
    } else {
      url = new URL(
        path,
        getPublicEnvVar("NODE_ENV") === "production"
          ? "https://api.inngest.com/"
          : "http://localhost:8288/",
      );
    }

    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("token", token);

    return url;
  }

  /**
   * TODO
   */
  public async connect() {
    this.#debug(
      `Establishing connection to channel "${
        this.#channelId
      }" with topics ${JSON.stringify(this.#topics)}...`,
    );

    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    let key = this.token.key;
    if (!key) {
      this.#debug(
        "No subscription token key passed; attempting to retrieve one automatically...",
      );

      if (!this.#signingKey) {
        throw new Error(
          "No subscription token key passed but have no signing key so cannot retrieve one",
        );
      }

      key = (
        await this.lazilyGetSubscriptionToken({
          ...this.token,
          signingKey: this.#signingKey,
          signingKeyFallback: this.#signingKeyFallback,
        })
      ).key;

      if (!key) {
        throw new Error(
          "No subscription token key passed and failed to retrieve one automatically",
        );
      }
    }

    const ret = createDeferredPromise<void>();

    try {
      this.#ws = new WebSocket(await this.getWsUrl(key));

      this.#ws.onopen = () => {
        this.#debug("WebSocket connection established");
        ret.resolve();
      };

      this.#ws.onmessage = async (event) => {
        const parseRes = await Realtime.messageSchema.safeParseAsync(
          JSON.parse(event.data as string),
        );

        if (!parseRes.success) {
          this.#debug("Received invalid message:", parseRes.error);
          return;
        }

        const msg = parseRes.data;

        if (!this.#running) {
          this.#debug(
            `Received message on channel "${msg.channel}" for topic "${msg.topic}" but stream is closed`,
          );
        }

        switch (msg.kind) {
          case "data": {
            if (!msg.channel) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no channel`,
              );
              return;
            }

            if (!msg.topic) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no topic`,
              );
              return;
            }

            const topic = this.#topics.get(msg.topic);
            if (!topic) {
              this.#debug(
                `Received message on channel "${msg.channel}" for unknown topic "${msg.topic}"`,
              );
              return;
            }

            const schema = topic.getSchema();
            if (schema) {
              const validateRes = await schema["~standard"].validate(msg.data);
              if (validateRes.issues) {
                console.error(
                  `Received message on channel "${msg.channel}" for topic "${msg.topic}" that failed schema validation:`,
                  validateRes.issues,
                );
                return;
              }

              msg.data = validateRes.value;
            }

            this.#debug(
              `Received message on channel "${msg.channel}" for topic "${msg.topic}":`,
              msg.data,
            );
            return this.#fanout.write({
              channel: msg.channel,
              topic: msg.topic,
              data: msg.data,
              fnId: msg.fn_id,
              createdAt: msg.created_at || new Date(),
              runId: msg.run_id,
              kind: "data",
              envId: msg.env_id,
            });
          }

          case "datastream-start": {
            if (!msg.channel) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no channel`,
              );
              return;
            }

            if (!msg.topic) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no topic`,
              );
              return;
            }

            const streamId: unknown = msg.data;
            if (typeof streamId !== "string" || !streamId) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no stream ID`,
              );
              return;
            }

            // `data` is a stream ID that we'll start receiving chunks with
            if (this.#chunkStreams.has(streamId)) {
              this.#debug(
                `Received message on channel "${msg.channel}" to create stream ID "${streamId}" that already exists`,
              );
              return;
            }

            const stream = new ReadableStream({
              start: (controller) => {
                this.#chunkStreams.set(streamId, { stream, controller });
              },

              cancel: () => {
                this.#chunkStreams.delete(streamId);
              },
            });

            this.#debug(
              `Created stream ID "${streamId}" on channel "${msg.channel}"`,
            );
            return this.#fanout.write({
              channel: msg.channel,
              topic: msg.topic,
              kind: "datastream-start",
              data: streamId,
              streamId,
              fnId: msg.fn_id,
              runId: msg.run_id,
              stream,
            });
          }

          case "datastream-end": {
            if (!msg.channel) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no channel`,
              );
              return;
            }

            if (!msg.topic) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no topic`,
              );
              return;
            }

            const streamId: unknown = msg.data;
            if (typeof streamId !== "string" || !streamId) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no stream ID`,
              );
              return;
            }

            // `data` is a stream ID that we'll stop receiving chunks with
            const stream = this.#chunkStreams.get(streamId);
            if (!stream) {
              this.#debug(
                `Received message on channel "${msg.channel}" to close stream ID "${streamId}" that doesn't exist`,
              );
              return;
            }

            stream.controller.close();
            this.#chunkStreams.delete(streamId);

            this.#debug(
              `Closed stream ID "${streamId}" on channel "${msg.channel}"`,
            );
            return this.#fanout.write({
              channel: msg.channel,
              topic: msg.topic,
              kind: "datastream-end",
              data: streamId,
              streamId,
              fnId: msg.fn_id,
              runId: msg.run_id,
              stream: stream.stream,
            });
          }

          case "chunk": {
            if (!msg.channel) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no channel`,
              );
              return;
            }

            if (!msg.topic) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no topic`,
              );
              return;
            }

            // `stream_id` is the ID of the stream we're receiving chunks for
            if (!msg.stream_id) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no stream ID`,
              );
              return;
            }

            const stream = this.#chunkStreams.get(msg.stream_id);
            if (!stream) {
              this.#debug(
                `Received message on channel "${msg.channel}" for unknown stream ID "${msg.stream_id}"`,
              );
              return;
            }

            this.#debug(
              `Received chunk on channel "${msg.channel}" for stream ID "${msg.stream_id}":`,
              msg.data,
            );

            stream.controller.enqueue(msg.data);

            return this.#fanout.write({
              channel: msg.channel,
              topic: msg.topic,
              kind: "chunk",
              data: msg.data,
              streamId: msg.stream_id,
              fnId: msg.fn_id,
              runId: msg.run_id,
              stream: stream.stream,
            });
          }

          default: {
            this.#debug(
              `Received message on channel "${msg.channel}" with unhandled kind "${msg.kind}"`,
            );
            return;
          }
        }
      };

      this.#ws.onerror = (event) => {
        console.error("WebSocket error observed:", event);
        ret.reject(event);
      };

      this.#ws.onclose = (event) => {
        this.#debug("WebSocket closed:", event.reason);
        this.close();
      };

      this.#running = true;
    } catch (err) {
      ret.reject(err);
    }

    return ret.promise;
  }

  /**
   * TODO
   */
  private async lazilyGetSubscriptionToken<
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
    args: {
      /**
       * TODO
       */
      channel: Realtime.Subscribe.InferChannelInput<InputChannel>;

      /**
       * TODO
       */
      topics: InputTopics;

      /**
       * TODO
       */
      signingKey: string;

      /**
       * TODO
       */
      signingKeyFallback?: string | undefined;
    },
  ): Promise<TToken> {
    const channelId =
      typeof args.channel === "string" ? args.channel : args.channel.name;

    if (!channelId) {
      throw new Error("Channel ID is required to create a subscription token");
    }

    const key = await api.getSubscriptionToken({
      channel: channelId,
      topics: args.topics,
      signingKey: args.signingKey,
      signingKeyFallback: args.signingKeyFallback,
      apiBaseUrl: this.#apiBaseUrl,
    });

    const token = {
      channel: channelId,
      topics: args.topics,
      key,
    } as TToken;

    return token;
  }

  /**
   * TODO
   */
  public close(
    /**
     * TODO
     */
    reason = "Userland closed connection",
  ) {
    if (!this.#running) {
      return;
    }

    this.#debug("close() called; closing connection...");
    this.#running = false;
    this.#ws?.close(1000, reason);

    this.#debug(`Closing ${this.#fanout.size()} streams...`);
    this.#fanout.close();
  }

  /**
   * TODO
   */
  public getJsonStream() {
    return this.#fanout.createStream();
  }

  /**
   * TODO
   */
  public getEncodedStream() {
    return this.#fanout.createStream((chunk) => {
      return this.#encoder.encode(`${JSON.stringify(chunk)}\n`);
    });
  }

  /**
   * TODO
   */
  public useCallback(
    callback: Realtime.Subscribe.Callback,
    stream: ReadableStream<Realtime.Message> = this.getJsonStream(),
  ) {
    void (async () => {
      // Explicitly get and manage the reader so that we can manually release
      // the lock if anything goes wrong or we're done with it.
      const reader = stream.getReader();
      try {
        while (this.#running) {
          const { done, value } = await reader.read();
          if (done || !this.#running) break;

          callback(value);
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }
}
