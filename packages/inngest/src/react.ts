import { useEffect, useRef, useState } from "react";
import type { Inngest } from "./components/Inngest.ts";
import {
  getSubscriptionToken,
  subscribe as realtimeSubscribe,
} from "./components/realtime/subscribe/index.ts";
import type { Realtime } from "./components/realtime/types.ts";

export enum RealtimeState {
  Closed = "closed",
  Error = "error",
  RefreshingToken = "refresh_token",
  Connecting = "connecting",
  Active = "active",
  Closing = "closing",
}

export type UseRealtimeConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "paused"
  | "closed"
  | "error";

export type UseRealtimeRunStatus =
  | "unknown"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type TokenFactory = () => Promise<string | Realtime.Subscribe.Token>;
type UseRealtimePauseReason = "hidden" | "disabled" | null;

//
// Extract the topic configs map from a channel input. Returns the full
// TopicsConfig when the channel is a typed ChannelInstance, otherwise
// falls back to a broad Record<string, TopicConfig> so data is untyped.
type InferTopicConfigs<TChannel extends Realtime.ChannelInput> =
  TChannel extends Realtime.ChannelInstance<string, infer TTopicConfigs>
    ? TTopicConfigs
    : Record<string, Realtime.TopicConfig>;

//
// Produce the per-topic typed message for a single topic key. When the
// channel is a typed ChannelInstance and the key matches a known topic,
// the `data` field is typed to that topic's schema. Otherwise falls
// back to untyped Realtime.Message.
type TopicLatestMessage<
  TChannel extends Realtime.ChannelInput,
  TKey extends string,
  TConfigs = InferTopicConfigs<TChannel>,
> = TKey extends keyof TConfigs
  ? Extract<
      Realtime.Message<string, Pick<TConfigs, TKey & keyof TConfigs>>,
      { topic: TKey }
    >
  : Realtime.Message;

//
// Map of topic name → last message with per-topic typed data.
// Falls back to bare Realtime.Message when the channel is a plain string.
type MessagesByTopicMap<
  TChannel extends Realtime.ChannelInput,
  TTopics extends readonly string[] | undefined,
> = TTopics extends readonly (infer K extends string)[]
  ? { [P in K]?: TopicLatestMessage<TChannel, P> }
  : Record<string, Realtime.Message | undefined>;

//
// Discriminated union of all messages across subscribed topics. Used for
// message collections where the user narrows by
// `msg.topic` to get per-topic typing.
type SubscribedMessage<
  TChannel extends Realtime.ChannelInput,
  TTopics extends readonly string[] | undefined,
> = TTopics extends readonly (infer K extends string)[]
  ? Realtime.Message<
      string,
      Pick<InferTopicConfigs<TChannel>, K & keyof InferTopicConfigs<TChannel>>
    >
  : Realtime.Message;

export interface UseRealtimeResult<
  TChannel extends Realtime.ChannelInput = Realtime.ChannelInput,
  TTopics extends readonly string[] | undefined = readonly string[] | undefined,
> {
  connectionStatus: UseRealtimeConnectionStatus;
  runStatus: UseRealtimeRunStatus;
  isPaused: boolean;
  pauseReason: UseRealtimePauseReason;

  messages: {
    byTopic: MessagesByTopicMap<TChannel, TTopics>;
    all: SubscribedMessage<TChannel, TTopics>[];
    last: SubscribedMessage<TChannel, TTopics> | null;
    delta: SubscribedMessage<TChannel, TTopics>[];
  };

  result: unknown;
  error: Error | null;
  reset: () => void;
}

export interface UseRealtimeOptions<
  TChannel extends Realtime.ChannelInput = Realtime.ChannelInput,
  TTopics extends readonly string[] | undefined = readonly string[] | undefined,
> {
  //
  // Spec-style inputs. If `token` is a function and returns a string, both
  // `channel` and `topics` are required so the hook can construct a token object.
  channel?: TChannel;
  topics?: TTopics;

  //
  // Either a pre-minted subscription token (legacy) or a token factory
  // (spec-style) that returns a token key or full token object.
  token?: Realtime.Subscribe.Token | TokenFactory;

  //
  // Legacy token refresher. Kept for compatibility with existing examples.
  refreshToken?: () => Promise<Realtime.Subscribe.Token>;

  key?: string;
  enabled?: boolean;
  bufferInterval?: number;

  //
  // Validation is enabled by default. Set to false to skip subscriber-side
  // schema validation for performance-sensitive use cases.
  validate?: boolean;

  //
  // Bound the number of messages retained in `messages.all`.
  // Set to `null` to disable the cap.
  historyLimit?: number | null;

  reconnect?: boolean;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  pauseOnHidden?: boolean;
  autoCloseOnTerminal?: boolean;
}

type RunLifecycleUpdate = {
  runStatus?: UseRealtimeRunStatus;
  result?: unknown;
};

const terminalRunStatuses = new Set<UseRealtimeRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const clampMessages = (
  prev: Realtime.Message[],
  next: Realtime.Message[],
  limit: number | null,
) => {
  const merged = [...prev, ...next];
  if (limit === null) {
    return merged;
  }

  if (limit <= 0) {
    return [];
  }

  return merged.length > limit ? merged.slice(-limit) : merged;
};

const getReconnectDelay = (attempt: number, minMs: number, maxMs: number) => {
  const jitter = Math.floor(Math.random() * minMs);
  return Math.min(maxMs, minMs * 2 ** attempt + jitter);
};

const toError = (err: unknown) => {
  return err instanceof Error ? err : new Error(String(err));
};

const normalizeRunStatus = (
  value: unknown,
): UseRealtimeRunStatus | undefined => {
  if (typeof value !== "string") {
    return;
  }

  switch (value.toLowerCase()) {
    case "running":
    case "in_progress":
      return "running";
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return;
  }
};

const inferRunLifecycleUpdate = (
  message: Realtime.Message,
): RunLifecycleUpdate => {
  if (message.kind !== "run") {
    return {};
  }

  const data = message.data;
  if (!data || typeof data !== "object") {
    return {};
  }

  const obj = data as Record<string, unknown>;
  const runStatus =
    normalizeRunStatus(obj.runStatus) ||
    normalizeRunStatus(obj.status) ||
    normalizeRunStatus(obj.state);

  if ("result" in obj) {
    return {
      runStatus,
      result: obj.result,
    };
  }

  if (runStatus === "completed" && "output" in obj) {
    return {
      runStatus,
      result: obj.output,
    };
  }

  return { runStatus };
};

const hasDocument = () => typeof document !== "undefined";

const isDocumentVisible = () => {
  if (!hasDocument()) {
    return true;
  }

  return document.visibilityState !== "hidden";
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const useRealtime = <
  TChannel extends Realtime.ChannelInput = Realtime.ChannelInput,
  TTopics extends readonly string[] | undefined = readonly string[] | undefined,
>({
  channel,
  topics,
  token: tokenInput,
  refreshToken,
  key,
  enabled = true,
  bufferInterval = 0,
  validate = true,
  historyLimit = 100,
  reconnect = true,
  reconnectMinMs = 250,
  reconnectMaxMs = 5_000,
  pauseOnHidden = true,
  autoCloseOnTerminal = true,
}: UseRealtimeOptions<TChannel, TTopics>): UseRealtimeResult<
  TChannel,
  TTopics
> => {
  const channelKey =
    typeof channel === "string" ? channel : (channel?.name ?? undefined);
  const topicsKey = topics ? JSON.stringify([...topics]) : "";
  const [allMessages, setAllMessages] = useState<Realtime.Message[]>([]);
  const [messageDelta, setMessageDelta] = useState<Realtime.Message[]>([]);
  const [messagesByTopic, setMessagesByTopic] = useState<
    Record<string, Realtime.Message | undefined>
  >({});
  const [error, setError] = useState<Error | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<UseRealtimeConnectionStatus>("idle");
  const [pauseReason, setPauseReason] = useState<UseRealtimePauseReason>(null);
  const [runStatus, setRunStatus] = useState<UseRealtimeRunStatus>("unknown");
  const [result, setResult] = useState<unknown>(undefined);
  const [isVisible, setIsVisible] = useState(() => isDocumentVisible());

  const subscriptionRef = useRef<Realtime.Subscribe.StreamSubscription | null>(
    null,
  );
  const readerRef =
    useRef<ReadableStreamDefaultReader<Realtime.Message> | null>(null);
  const messageBufferRef = useRef<Realtime.Message[]>([]);
  const bufferIntervalRef = useRef(bufferInterval);
  const messageLimitRef = useRef(historyLimit);
  const runStatusRef = useRef(runStatus);

  useEffect(() => {
    runStatusRef.current = runStatus;
  }, [runStatus]);

  useEffect(() => {
    bufferIntervalRef.current = bufferInterval;
  }, [bufferInterval]);

  useEffect(() => {
    messageLimitRef.current = historyLimit;
  }, [historyLimit]);

  useEffect(() => {
    if (!pauseOnHidden || !hasDocument()) {
      return;
    }

    const onVisibilityChange = () => {
      setIsVisible(isDocumentVisible());
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [pauseOnHidden]);

  const reset = () => {
    messageBufferRef.current = [];
    setAllMessages([]);
    setMessageDelta([]);
    setMessagesByTopic({});
    setResult(undefined);
  };

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    if (bufferInterval > 0) {
      interval = setInterval(() => {
        if (messageBufferRef.current.length === 0) {
          return;
        }

        const buffered = [...messageBufferRef.current];
        messageBufferRef.current = [];
        setMessageDelta(buffered);
        setAllMessages((prev) =>
          clampMessages(prev, buffered, messageLimitRef.current),
        );
      }, bufferInterval);
    }

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [bufferInterval]);

  useEffect(() => {
    const shouldRun = enabled && (!pauseOnHidden || isVisible);
    if (!shouldRun) {
      const nextPauseReason = !enabled
        ? "disabled"
        : pauseOnHidden && !isVisible
          ? "hidden"
          : null;

      if (nextPauseReason) {
        setPauseReason(nextPauseReason);
        setConnectionStatus("paused");
      } else {
        setPauseReason(null);
        setConnectionStatus("idle");
      }
      return;
    }

    setPauseReason(null);

    let cancelled = false;

    const cleanupConnection = async (reason = "useRealtime cleanup") => {
      const reader = readerRef.current;
      const sub = subscriptionRef.current;

      readerRef.current = null;
      subscriptionRef.current = null;

      try {
        await reader?.cancel();
      } catch {
        // no-op
      }

      try {
        reader?.releaseLock();
      } catch {
        // no-op
      }

      try {
        sub?.unsubscribe(reason);
      } catch {
        // no-op
      }
    };

    const resolveToken = async (): Promise<Realtime.Subscribe.Token> => {
      if (tokenInput && typeof tokenInput !== "function") {
        return tokenInput;
      }

      if (typeof tokenInput === "function") {
        const next = await tokenInput();
        if (typeof next === "string") {
          if (!channel || !topics) {
            throw new Error(
              "useRealtime token() returned a string but channel/topics were not provided",
            );
          }

          return {
            channel: channel as Realtime.ChannelInput,
            topics: topics as string[],
            key: next,
          } as Realtime.Subscribe.Token;
        }

        return next;
      }

      if (refreshToken) {
        return await refreshToken();
      }

      throw new Error("No token provided and no token/refreshToken handler.");
    };

    const applyMessage = (message: Realtime.Message) => {
      if (message.kind === "run") {
        const lifecycle = inferRunLifecycleUpdate(message);

        if (lifecycle.runStatus) {
          runStatusRef.current = lifecycle.runStatus;
          setRunStatus(lifecycle.runStatus);
        }
        if ("result" in lifecycle) {
          setResult(lifecycle.result);
        }
        return;
      }

      if (runStatusRef.current === "unknown") {
        runStatusRef.current = "running";
        setRunStatus("running");
      }

      if (message.topic) {
        setMessagesByTopic((prev) => ({
          ...prev,
          [message.topic as string]: message,
        }));
      }

      if (bufferIntervalRef.current === 0) {
        setMessageDelta([message]);
        setAllMessages((prev) =>
          clampMessages(prev, [message], messageLimitRef.current),
        );
        return;
      }

      messageBufferRef.current.push(message);
    };

    const run = async () => {
      let reconnectAttempt = 0;

      while (!cancelled) {
        try {
          setError(null);
          setConnectionStatus("connecting");

          const token = await resolveToken();
          if (cancelled) {
            break;
          }

          const stream = (await realtimeSubscribe({
            ...token,
            validate,
          })) as Realtime.Subscribe.StreamSubscription;

          if (cancelled) {
            stream.unsubscribe("useRealtime cancelled before start");
            break;
          }

          reconnectAttempt = 0;
          subscriptionRef.current = stream;
          setConnectionStatus("open");

          if (runStatusRef.current === "unknown") {
            runStatusRef.current = "running";
            setRunStatus("running");
          }

          const reader = stream.getReader();
          readerRef.current = reader;

          try {
            while (!cancelled) {
              const { done, value } = await reader.read();
              if (done || cancelled) {
                break;
              }

              applyMessage(value);

              if (
                autoCloseOnTerminal &&
                terminalRunStatuses.has(runStatusRef.current)
              ) {
                stream.unsubscribe("Run reached terminal status");
                break;
              }
            }
          } finally {
            try {
              reader.releaseLock();
            } catch {
              // no-op
            }
            if (readerRef.current === reader) {
              readerRef.current = null;
            }
          }

          if (cancelled) {
            break;
          }

          setConnectionStatus("closed");

          if (
            autoCloseOnTerminal &&
            terminalRunStatuses.has(runStatusRef.current)
          ) {
            break;
          }

          if (!reconnect) {
            break;
          }
        } catch (err) {
          if (cancelled) {
            break;
          }

          setError(toError(err));
          setConnectionStatus("error");

          if (!reconnect) {
            break;
          }
        } finally {
          await cleanupConnection("reconnect cycle cleanup");
        }

        if (cancelled || !reconnect) {
          break;
        }

        const delay = getReconnectDelay(
          reconnectAttempt++,
          reconnectMinMs,
          reconnectMaxMs,
        );
        await sleep(delay);
      }
    };

    void run().catch((err) => {
      if (!cancelled) {
        setError(toError(err));
        setConnectionStatus("error");
      }
    });

    return () => {
      cancelled = true;
      void cleanupConnection("useRealtime unmount");
      setConnectionStatus((prev) => (prev === "open" ? "closed" : prev));
    };
  }, [
    autoCloseOnTerminal,
    channelKey,
    enabled,
    isVisible,
    key,
    pauseOnHidden,
    reconnect,
    reconnectMaxMs,
    reconnectMinMs,
    refreshToken,
    tokenInput,
    topicsKey,
    validate,
  ]);

  const lastMessage = allMessages[allMessages.length - 1] ?? null;
  const isPaused = connectionStatus === "paused";

  return {
    connectionStatus,
    runStatus,
    isPaused,
    pauseReason,

    messages: {
      byTopic: messagesByTopic as MessagesByTopicMap<TChannel, TTopics>,
      all: allMessages,
      last: lastMessage,
      delta: messageDelta,
    },

    result,
    error,
    reset,
  } as UseRealtimeResult<TChannel, TTopics>;
};

export { getSubscriptionToken };
export type { Inngest };
