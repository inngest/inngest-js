import { useEffect, useRef, useState } from "react";
import { subscribe } from "./subscribe";
import { type Realtime } from "./types";

export enum InngestSubscriptionState {
  Closed = "closed",
  Error = "error",
  RefreshingToken = "refresh_token",
  Connecting = "connecting",
  Active = "active",
  Closing = "closing",
}

/**
 * TODO
 */
export interface InngestSubscription<TToken extends Realtime.Subscribe.Token> {
  /**
   * TODO
   */
  data: Realtime.Subscribe.Token.InferMessage<TToken>[];

  /**
   * TODO
   */
  latestData: Realtime.Subscribe.Token.InferMessage<TToken> | null;

  /**
   * TODO
   */
  freshData: Realtime.Subscribe.Token.InferMessage<TToken>[];

  /**
   * TODO
   */
  error: Error | null;

  /**
   * TODO
   */
  state: InngestSubscriptionState;
}

/**
 * TODO
 */
export function useInngestSubscription<
  const TToken extends Realtime.Subscribe.Token | null | undefined,
>({
  token: tokenInput,
  refreshToken,
  key,
  enabled = true,
  bufferInterval = 0,
}: {
  /**
   * TODO
   */
  token?: TToken;

  /**
   * TODO
   */
  refreshToken?: () => Promise<TToken>;

  /**
   * TODO
   */
  key?: string;

  /**
   * TODO
   */
  enabled?: boolean;

  /**
   * TODO
   */
  bufferInterval?: number;
}): InngestSubscription<NonNullable<TToken>> {
  const [token, setToken] = useState<TToken | null | undefined>(tokenInput);
  const [data, setData] = useState<Realtime.Message[]>([]);
  const [freshData, setFreshData] = useState<Realtime.Message[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [state, setState] = useState<InngestSubscriptionState>(
    InngestSubscriptionState.Closed,
  );

  const subscriptionRef = useRef<Realtime.Subscribe.StreamSubscription | null>(
    null,
  );
  const readerRef =
    useRef<ReadableStreamDefaultReader<Realtime.Message> | null>(null);
  const messageBuffer = useRef<Realtime.Message[]>([]);
  const bufferIntervalRef = useRef<number>(bufferInterval);

  // Sync token if tokenInput prop changes
  useEffect(() => {
    if (tokenInput) setToken(tokenInput);
  }, [tokenInput]);

  // Token fetch fallback on mount
  useEffect(() => {
    if (!token && enabled) {
      if (refreshToken) {
        setState(InngestSubscriptionState.RefreshingToken);
        refreshToken()
          .then((newToken) => setToken(newToken))
          .catch((err) => {
            setError(err);
            setState(InngestSubscriptionState.Error);
          });
      } else {
        setError(new Error("No token provided and no refreshToken handler."));
        setState(InngestSubscriptionState.Error);
      }
    }
  }, []);

  // Subscription management
  useEffect(() => {
    setError(null);
    if (!enabled || !token) return;
    let cancelled = false;

    const start = async () => {
      try {
        setState(InngestSubscriptionState.Connecting);
        const stream = await subscribe({ ...token });
        if (cancelled) return;

        subscriptionRef.current = stream;
        setState(InngestSubscriptionState.Active);

        // Explicitly get and manage the reader so that we can manually release
        // the lock if anything goes wrong or we're done with it.
        //
        // Especially when this is unmounted.
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

        // Stream has closed cleanly
        if (!cancelled) {
          setState(InngestSubscriptionState.Closed);
          if (enabled) start();
        }
      } catch (err) {
        if (cancelled) return;
        if (refreshToken) {
          setState(InngestSubscriptionState.RefreshingToken);
          refreshToken()
            .then((newToken) => setToken(newToken))
            .catch((e) => {
              setError(e);
              setState(InngestSubscriptionState.Error);
            });
        } else {
          setError(err as Error);
          setState(InngestSubscriptionState.Error);
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
          console.error("Error cleaning up Inngest subscription", err);
        })
        .finally(() => {
          // Ensure state is always updated even if cleanup fails
          setState(InngestSubscriptionState.Closed);
        });
    };
  }, [token, enabled, key]);

  // Buffer flushing
  useEffect(() => {
    bufferIntervalRef.current = bufferInterval;
    let interval: NodeJS.Timeout | null = null;

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
  } as unknown as InngestSubscription<NonNullable<TToken>>;
}
