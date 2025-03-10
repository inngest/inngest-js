import { Inngest } from "inngest";
import { type Realtime } from "inngest/experimental";
import { useEffect, useRef, useState } from "react";

export enum InngestSubscriptionState {
  Closed = "closed",
  Error = "error",
  RefreshingToken = "refresh_token",
  Connecting = "connecting",
  Active = "active",
  Closing = "closing",
}

export interface InngestSubscription<TToken extends Realtime.Subscribe.Token> {
  data: Realtime.Subscribe.Token.InferMessage<TToken>[];
  latestData: Realtime.Subscribe.Token.InferMessage<TToken> | null;
  freshData: Realtime.Subscribe.Token.InferMessage<TToken>[];
  error: Error | null;
  state: InngestSubscriptionState;
}

export function useInngestSubscription<
  const TToken extends Realtime.Subscribe.Token | null | undefined,
>({
  app,
  token: tokenInput,
  refreshToken,
  key,
  enabled = true,
  bufferInterval = 0,
}: {
  app: Inngest.Any;
  token?: TToken;
  refreshToken?: () => Promise<TToken>;
  key?: string;
  enabled?: boolean;
  bufferInterval?: number;
}): InngestSubscription<NonNullable<TToken>> {
  const [token, setToken] = useState<TToken | null | undefined>(tokenInput);
  const [data, setData] = useState<Realtime.Message[]>([]);
  const [latestData, setLatestData] = useState<Realtime.Message | null>(null);
  const [freshData, setFreshData] = useState<Realtime.Message[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [state, setState] = useState<InngestSubscriptionState>(
    InngestSubscriptionState.Closed
  );

  const subscriptionRef = useRef<Realtime.Subscribe.StreamSubscription | null>(
    null
  );
  const messageBuffer = useRef<Realtime.Message[]>([]);
  const bufferIntervalRef = useRef<number>(bufferInterval);

  // Sync token if tokenInput prop changes
  useEffect(() => {
    if (tokenInput) setToken(tokenInput);
  }, [tokenInput]);

  // Token fetch fallback on mount
  useEffect(() => {
    if (!token) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscription management
  useEffect(() => {
    setError(null);
    if (!enabled || !token) return;
    let cancelled = false;

    const start = async () => {
      try {
        setState(InngestSubscriptionState.Connecting);
        const stream = await app.subscribe({ ...token });
        if (cancelled) return;

        subscriptionRef.current = stream;
        setState(InngestSubscriptionState.Active);

        for await (const message of stream) {
          if (cancelled) break;

          if (bufferIntervalRef.current === 0) {
            setFreshData([message]);
            setLatestData(message);
            setData((prev) => [...prev, message]);
          } else {
            messageBuffer.current.push(message);
          }
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
      if (subscriptionRef.current) {
        setState(InngestSubscriptionState.Closing);
        subscriptionRef.current.close().finally(() => {
          setState(InngestSubscriptionState.Closed);
        });
      } else {
        setState(InngestSubscriptionState.Closed);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, enabled, key]);

  // Buffer flushing
  useEffect(() => {
    bufferIntervalRef.current = bufferInterval;
    let interval: number | null = null;

    if (bufferInterval > 0) {
      interval = setInterval(() => {
        if (messageBuffer.current.length > 0) {
          const buffered = [...messageBuffer.current];
          messageBuffer.current = [];

          setFreshData(buffered);
          setData((prev) => [...prev, ...buffered]);
          setLatestData(buffered[buffered.length - 1]);
        }
      }, bufferInterval);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [bufferInterval]);

  return { data, latestData, freshData, error, state } as InngestSubscription<
    NonNullable<TToken>
  >;
}
