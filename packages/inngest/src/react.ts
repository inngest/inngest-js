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

export interface UseRealtimeResult {
  data: Realtime.Message[];
  latestData: Realtime.Message | null;
  freshData: Realtime.Message[];
  error: Error | null;
  state: RealtimeState;
}

export interface UseRealtimeOptions {
  //
  // Pre-minted subscription token. If provided, skips token generation.
  //
  token?: Realtime.Subscribe.Token;

  //
  // Async function to fetch/refresh a subscription token.
  // Called on mount (if no token) and on reconnect after errors.
  //
  refreshToken?: () => Promise<Realtime.Subscribe.Token>;

  //
  // Key to force a new subscription (changing this reconnects).
  //
  key?: string;

  //
  // Whether the subscription is active. Defaults to true.
  //
  enabled?: boolean;

  //
  // Batch messages for this interval (ms) before flushing to state.
  // 0 = flush immediately. Defaults to 0.
  //
  bufferInterval?: number;
}

export const useRealtime = ({
  token: tokenInput,
  refreshToken,
  key,
  enabled = true,
  bufferInterval = 0,
}: UseRealtimeOptions): UseRealtimeResult => {
  const [token, setToken] = useState<
    Realtime.Subscribe.Token | null | undefined
  >(tokenInput);
  const [data, setData] = useState<Realtime.Message[]>([]);
  const [freshData, setFreshData] = useState<Realtime.Message[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [state, setState] = useState<RealtimeState>(RealtimeState.Closed);

  const subscriptionRef = useRef<Realtime.Subscribe.StreamSubscription | null>(
    null,
  );
  const readerRef =
    useRef<ReadableStreamDefaultReader<Realtime.Message> | null>(null);
  const messageBuffer = useRef<Realtime.Message[]>([]);
  const bufferIntervalRef = useRef<number>(bufferInterval);

  //
  // Sync token when tokenInput prop changes
  //
  useEffect(() => {
    if (tokenInput) setToken(tokenInput);
  }, [tokenInput]);

  //
  // Fetch token on mount if not provided
  //
  useEffect(() => {
    if (!token && enabled) {
      if (refreshToken) {
        setState(RealtimeState.RefreshingToken);
        refreshToken()
          .then((newToken) => setToken(newToken))
          .catch((err) => {
            setError(err);
            setState(RealtimeState.Error);
          });
      } else {
        setError(new Error("No token provided and no refreshToken handler."));
        setState(RealtimeState.Error);
      }
    }
  }, [enabled]);

  //
  // Main subscription lifecycle
  //
  useEffect(() => {
    setError(null);
    if (!enabled || !token) return;
    let cancelled = false;

    const start = async () => {
      try {
        setState(RealtimeState.Connecting);
        const stream = await realtimeSubscribe({ ...token });
        if (cancelled) return;

        subscriptionRef.current = stream;
        setState(RealtimeState.Active);

        const reader = stream.getReader();
        readerRef.current = reader;

        try {
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;

            if (bufferIntervalRef.current === 0) {
              setFreshData([value]);
              setData((prev) => [...prev, value]);
            } else {
              messageBuffer.current.push(value);
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Reader might already be released
          }
          readerRef.current = null;
        }

        //
        // Stream closed cleanly — reconnect if still enabled
        //
        if (!cancelled) {
          setState(RealtimeState.Closed);
          if (enabled) start();
        }
      } catch (err) {
        if (cancelled) return;

        if (refreshToken) {
          setState(RealtimeState.RefreshingToken);
          refreshToken()
            .then((newToken) => setToken(newToken))
            .catch((e) => {
              setError(e);
              setState(RealtimeState.Error);
            });
        } else {
          setError(err as Error);
          setState(RealtimeState.Error);
        }
      }
    };

    start();

    return () => {
      cancelled = true;

      const cleanup = async () => {
        const readerToRemove = readerRef.current;
        const subToRemove = subscriptionRef.current;
        readerRef.current = null;
        subscriptionRef.current = null;

        try {
          await readerToRemove?.cancel();
        } catch {
          // Reader might already be cancelled
        }

        try {
          readerToRemove?.releaseLock();
        } catch {
          // Reader might already be released
        }

        try {
          await subToRemove?.cancel();
        } catch {
          // Subscription might already be cancelled
        }
      };

      cleanup()
        .catch((err) => {
          console.error("Error cleaning up realtime subscription", err);
        })
        .finally(() => {
          setState(RealtimeState.Closed);
        });
    };
  }, [token, enabled, key]);

  //
  // Buffer flushing interval
  //
  useEffect(() => {
    bufferIntervalRef.current = bufferInterval;
    let interval: ReturnType<typeof setInterval> | null = null;

    if (bufferInterval > 0) {
      interval = setInterval(() => {
        if (messageBuffer.current.length > 0) {
          const buffered = [...messageBuffer.current];
          messageBuffer.current = [];
          setFreshData(buffered);
          setData((prev) => [...prev, ...buffered]);
        }
      }, bufferInterval);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [bufferInterval]);

  return {
    data,
    latestData: data[data.length - 1] ?? null,
    freshData,
    error,
    state,
  };
};

//
// Re-export getSubscriptionToken for server-side token minting
//
export { getSubscriptionToken };

//
// Helper type for the Inngest client needed by getSubscriptionToken
//
export type { Inngest };
