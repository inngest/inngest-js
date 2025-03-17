import debug from "debug";
import { type Inngest } from "inngest";
import { devServerAvailable, devServerHost } from "inngest/helpers/devserver";
import { topic } from "../topic";
import { Realtime } from "../types";
import { createDeferredPromise } from "../util";
import { getSubscriptionToken } from "./helpers";
import { StreamFanout } from "./StreamFanout";

/**
 * TODO
 */
export class TokenSubscription {
  #app: Inngest.Any;
  #channelId: string;
  #debug = debug("inngest:realtime");
  #encoder = new TextEncoder();
  #fanout = new StreamFanout<Realtime.Message>();
  #running = false;
  #topics: Map<string, Realtime.Topic.Definition>;
  #ws: WebSocket | null = null;

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
    app: Inngest.Like,

    /**
     * TODO
     */
    public token: Realtime.Subscribe.Token,
  ) {
    this.#app = app as Inngest.Any;

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

    if (this.#app.apiBaseUrl) {
      url = new URL(path, this.#app.apiBaseUrl);
    } else {
      url = new URL(path, "https://api.inngest.com/");

      if (
        this.#app["mode"].isDev &&
        this.#app["mode"].isInferred &&
        !this.#app.apiBaseUrl
      ) {
        const host = devServerHost();
        const devAvailable = await devServerAvailable(
          host,
          this.#app["fetch"],
        );

        if (devAvailable) {
          url = new URL(path, host);
        }
      }
    }

    url.protocol = "ws:";
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

    const key =
      this.token.key || (await getSubscriptionToken(this.#app, this.token)).key;
    if (!key) {
      throw new Error(
        "No subscription token key passed and failed to retrieve one automatically",
      );
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
  public close(
    /**
     * TODO
     */
    reason: string = "Userland closed connection",
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
      for await (const chunk of stream) {
        if (!this.#running) return;

        callback(chunk);
      }
    })();
  }
}
