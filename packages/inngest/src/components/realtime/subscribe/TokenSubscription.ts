import type { StandardSchemaV1 } from "@standard-schema/spec";
import debug from "debug";
import { allProcessEnv, parseAsBoolean } from "../../../helpers/env.ts";
import { createDeferredPromise } from "../../../helpers/promises.ts";
import { Realtime } from "../types.ts";
import { StreamFanout } from "./StreamFanout.ts";

//
// Extract a StandardSchema from either a new TopicConfig ({ schema }) or
// an old Topic.Definition (has .getSchema()). Returns undefined when the
// topic is type-only or has no schema.
const extractSchema = (topicEntry: unknown): StandardSchemaV1 | undefined => {
  if (!topicEntry || typeof topicEntry !== "object") return undefined;

  // New declarative TopicConfig: { schema: StandardSchemaV1 }
  if ("schema" in topicEntry && topicEntry.schema) {
    return topicEntry.schema as StandardSchemaV1;
  }

  // Old Topic.Definition: has .getSchema() method
  if ("getSchema" in topicEntry && typeof topicEntry.getSchema === "function") {
    return topicEntry.getSchema() as StandardSchemaV1 | undefined;
  }

  return undefined;
};

export interface TokenSubscriptionOptions {
  token: Realtime.Subscribe.Token;
  apiBaseUrl?: string;
  signingKey?: string;
  signingKeyFallback?: string;
  validate?: boolean;

  //
  // When provided, used for lazy token retrieval instead of env-based lookup
  getSubscriptionToken?: (channel: string, topics: string[]) => Promise<string>;
}

export class TokenSubscription {
  #apiBaseUrl?: string;
  #channelId: string;
  #debug = debug("inngest:realtime");
  #encoder = new TextEncoder();
  #fanout = new StreamFanout<Realtime.Message>();
  #running = false;
  #topics: Map<string, unknown>;
  #ws: WebSocket | null = null;
  #signingKey: string | undefined;
  #signingKeyFallback: string | undefined;
  #validate: boolean;
  #getSubscriptionToken?: (
    channel: string,
    topics: string[]
  ) => Promise<string>;

  #chunkStreams = new Map<
    string,
    { stream: ReadableStream; controller: ReadableStreamDefaultController }
  >();

  public token: Realtime.Subscribe.Token;

  constructor(options: TokenSubscriptionOptions) {
    this.token = options.token;
    this.#apiBaseUrl = options.apiBaseUrl;
    this.#signingKey = options.signingKey;
    this.#signingKeyFallback = options.signingKeyFallback;
    this.#validate = options.validate ?? true;
    this.#getSubscriptionToken = options.getSubscriptionToken;

    if (typeof options.token.channel === "string") {
      this.#channelId = options.token.channel;

      //
      // String channel — no topic definitions available, store empty entries.
      // Schema validation will be skipped for these topics.
      this.#topics = new Map(
        this.token.topics.map((name) => [name, undefined])
      );
    } else {
      this.#channelId = options.token.channel.name;

      //
      // Channel object — store the topic config (new TopicConfig or old
      // Topic.Definition) for optional schema validation on received messages.
      this.#topics = new Map(
        this.token.topics.map((name) => [
          name,
          options.token.channel.topics?.[name],
        ])
      );
    }
  }

  private getWsUrl(token: string): URL {
    const path = "/v1/realtime/connect";
    const env = allProcessEnv();
    const devEnvVar = env.INNGEST_DEV;

    let url: URL;

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
        env.NODE_ENV === "production"
          ? "https://api.inngest.com/"
          : "http://localhost:8288/"
      );
    }

    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("token", token);

    return url;
  }

  public async connect() {
    this.#debug(
      `Establishing connection to channel "${
        this.#channelId
      }" with topics ${JSON.stringify([...this.#topics.keys()])}...`
    );

    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    let key = this.token.key;
    if (!key) {
      this.#debug(
        "No subscription token key passed; attempting to retrieve one automatically..."
      );

      key = await this.lazilyGetSubscriptionToken();

      if (!key) {
        throw new Error(
          "No subscription token key passed and failed to retrieve one automatically"
        );
      }
    }

    const ret = createDeferredPromise<void>();
    let isConnectSettled = false;
    let hasOpened = false;

    const resolveConnect = () => {
      if (isConnectSettled) {
        return;
      }
      isConnectSettled = true;
      ret.resolve();
    };

    const rejectConnect = (err: unknown) => {
      if (isConnectSettled) {
        return;
      }
      isConnectSettled = true;
      ret.reject(err);
    };

    try {
      this.#ws = new WebSocket(this.getWsUrl(key));

      this.#ws.onopen = () => {
        this.#debug("WebSocket connection established");
        hasOpened = true;
        resolveConnect();
      };

      this.#ws.onmessage = async (event) => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(event.data as string);
        } catch (err) {
          this.#debug("Received non-JSON message:", err);
          return;
        }

        const parseRes =
          await Realtime.messageSchema.safeParseAsync(parsedJson);

        if (!parseRes.success) {
          this.#debug("Received invalid message:", parseRes.error);
          return;
        }

        const msg = parseRes.data;

        if (!this.#running) {
          this.#debug(
            `Received message on channel "${msg.channel}" for topic "${msg.topic}" but stream is closed`
          );
        }

        switch (msg.kind) {
          case "data": {
            if (!msg.channel) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no channel`
              );
              return;
            }

            if (!msg.topic) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no topic`
              );
              return;
            }

            if (!this.#topics.has(msg.topic)) {
              this.#debug(
                `Received message on channel "${msg.channel}" for unknown topic "${msg.topic}"`
              );
              return;
            }

            const dataTopic = this.#topics.get(msg.topic);
            const schema = extractSchema(dataTopic);
            if (this.#validate && schema) {
              const validateRes = await schema["~standard"].validate(msg.data);
              if (validateRes.issues) {
                console.error(
                  `Received message on channel "${msg.channel}" for topic "${msg.topic}" that failed schema validation:`,
                  validateRes.issues
                );
                return;
              }

              msg.data = validateRes.value;
            }

            this.#debug(
              `Received message on channel "${msg.channel}" for topic "${msg.topic}":`,
              msg.data
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

          case "run": {
            this.#debug(`Received run lifecycle message on "${msg.channel}"`);
            return this.#fanout.write({
              channel: msg.channel,
              topic: msg.topic,
              data: msg.data,
              fnId: msg.fn_id,
              createdAt: msg.created_at || new Date(),
              runId: msg.run_id,
              kind: "run",
              envId: msg.env_id,
            });
          }

          case "datastream-start": {
            if (!msg.channel || !msg.topic) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no channel or topic`
              );
              return;
            }

            const streamId: unknown = msg.data;
            if (typeof streamId !== "string" || !streamId) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no stream ID`
              );
              return;
            }

            if (this.#chunkStreams.has(streamId)) {
              this.#debug(
                `Received message on channel "${msg.channel}" to create stream ID "${streamId}" that already exists`
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
              `Created stream ID "${streamId}" on channel "${msg.channel}"`
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
            if (!msg.channel || !msg.topic) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no channel or topic`
              );
              return;
            }

            const endStreamId: unknown = msg.data;
            if (typeof endStreamId !== "string" || !endStreamId) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no stream ID`
              );
              return;
            }

            const endStream = this.#chunkStreams.get(endStreamId);
            if (!endStream) {
              this.#debug(
                `Received message on channel "${msg.channel}" to close stream ID "${endStreamId}" that doesn't exist`
              );
              return;
            }

            endStream.controller.close();
            this.#chunkStreams.delete(endStreamId);

            this.#debug(
              `Closed stream ID "${endStreamId}" on channel "${msg.channel}"`
            );
            return this.#fanout.write({
              channel: msg.channel,
              topic: msg.topic,
              kind: "datastream-end",
              data: endStreamId,
              streamId: endStreamId,
              fnId: msg.fn_id,
              runId: msg.run_id,
              stream: endStream.stream,
            });
          }

          case "chunk": {
            if (!msg.channel || !msg.topic) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no channel or topic`
              );
              return;
            }

            if (!msg.stream_id) {
              this.#debug(
                `Received message on channel "${msg.channel}" with no stream ID`
              );
              return;
            }

            const chunkStream = this.#chunkStreams.get(msg.stream_id);
            if (!chunkStream) {
              this.#debug(
                `Received message on channel "${msg.channel}" for unknown stream ID "${msg.stream_id}"`
              );
              return;
            }

            this.#debug(
              `Received chunk on channel "${msg.channel}" for stream ID "${msg.stream_id}":`,
              msg.data
            );

            chunkStream.controller.enqueue(msg.data);

            return this.#fanout.write({
              channel: msg.channel,
              topic: msg.topic,
              kind: "chunk",
              data: msg.data,
              streamId: msg.stream_id,
              fnId: msg.fn_id,
              runId: msg.run_id,
              stream: chunkStream.stream,
            });
          }

          default: {
            this.#debug(
              `Received message on channel "${msg.channel}" with unhandled kind "${msg.kind}"`
            );
            return;
          }
        }
      };

      this.#ws.onerror = (event) => {
        console.error("WebSocket error observed:", event);
        rejectConnect(event);
      };

      this.#ws.onclose = (event) => {
        this.#debug("WebSocket closed:", event.reason);
        if (!hasOpened) {
          rejectConnect(
            new Error(
              `WebSocket closed before opening${
                event.reason ? `: ${event.reason}` : ""
              }`
            )
          );
        }
        this.close();
      };

      this.#running = true;
    } catch (err) {
      ret.reject(err);
    }

    return ret.promise;
  }

  private async lazilyGetSubscriptionToken(): Promise<string> {
    const channelId = this.#channelId;

    if (!channelId) {
      throw new Error("Channel ID is required to create a subscription token");
    }

    if (this.#getSubscriptionToken) {
      return this.#getSubscriptionToken(
        channelId,
        this.token.topics as string[]
      );
    }

    //
    // Fallback: try fetching directly using env-based signing keys.
    // This path is used when no Inngest client is available.
    throw new Error(
      "No getSubscriptionToken handler provided. Pass an Inngest client or provide a token key."
    );
  }

  public close(reason = "Userland closed connection") {
    if (!this.#running) {
      return;
    }

    this.#debug("close() called; closing connection...");
    this.#running = false;
    this.#ws?.close(1000, reason);
    this.#ws = null;

    for (const { controller } of this.#chunkStreams.values()) {
      try {
        controller.close();
      } catch {
        // no-op
      }
    }
    this.#chunkStreams.clear();

    this.#debug(`Closing ${this.#fanout.size()} streams...`);
    this.#fanout.close();
  }

  public getJsonStream() {
    return this.#fanout.createStream();
  }

  public getEncodedStream() {
    return this.#fanout.createStream((chunk) => {
      return this.#encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    });
  }

  public useCallback(
    callback: Realtime.Subscribe.Callback,
    stream: ReadableStream<Realtime.Message> = this.getJsonStream(),
    onError?: (err: unknown) => void
  ) {
    void (async () => {
      const reader = stream.getReader();
      try {
        while (this.#running) {
          const { done, value } = await reader.read();
          if (done || !this.#running) break;
          try {
            await callback(value);
          } catch (err) {
            if (onError) {
              onError(err);
            } else {
              console.error("Realtime subscription callback failed:", err);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }
}
