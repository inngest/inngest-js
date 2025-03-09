import { Inngest } from "inngest";
import { type Realtime } from "inngest/experimental";
import { useEffect, useRef, useState } from "react";

export interface InngestSubsription<TToken extends Realtime.Subscribe.Token> {
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
  isReady: boolean;
}

/**
 * TODO
 */
export function useInngestSubscription<
  const InputChannel extends
    | Realtime.Channel.Definition
    | Realtime.Channel
    | string,
  const InputTopics extends (keyof Realtime.Channel.InferTopics<
    Realtime.Channel.AsChannel<InputChannel>
  > &
    string)[],
  const TToken extends Realtime.Subscribe.Token<
    Realtime.Channel.AsChannel<InputChannel>,
    InputTopics
  >,
>({
  app,
  channel,
  topics,
  key,
  enabled = true,
  bufferInterval = 0,
}: {
  /**
   * TODO
   */
  app: Inngest.Any;

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
  key?: string;

  /**
   * TODO
   */
  enabled?: boolean;

  /**
   * TODO
   */
  bufferInterval?: number;

  /**
   * TODO
   */
}): InngestSubsription<TToken> {
  const [data, setData] = useState<Realtime.Message[]>([]);
  const [latestData, setLatestData] = useState<Realtime.Message | null>(null);
  const [freshData, setFreshData] = useState<Realtime.Message[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [isReady, setIsReady] = useState(false);
  const subscriptionRef = useRef<Realtime.Subscribe.StreamSubscription | null>(
    null
  );
  const messageBuffer = useRef<Realtime.Message[]>([]);
  const bufferIntervalRef = useRef<number>(bufferInterval);
  const isMountedRef = useRef<boolean>(true);

  // Manages the subscription
  useEffect(() => {
    if (!enabled) return;
    if (!app || !channel || !topics?.length) {
      setError(new Error("Missing required parameters"));
      return;
    }

    isMountedRef.current = true;

    const subscribe = async () => {
      try {
        // @ts-expect-error TODO `key` not a valid prop, though we pass it with
        // token.
        const stream = await app.subscribe({ channel, topics, key });
        subscriptionRef.current = stream;
        setIsReady(true);

        for await (const message of stream) {
          if (!isMountedRef.current) break;

          if (bufferIntervalRef.current === 0) {
            setFreshData([message]);
            setData((prev) => [...prev, message]);
            setLatestData(message);
          } else {
            messageBuffer.current.push(message);
          }
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        setError(err as Error);
      }
    };

    subscribe();

    return () => {
      isMountedRef.current = false;
      subscriptionRef.current?.close();
    };
  }, [app, channel, topics, enabled, key]);

  // Manages optional buffering to control UI updates
  useEffect(() => {
    bufferIntervalRef.current = bufferInterval;
    let bufferIntervalId: number | null = null;

    if (bufferInterval > 0) {
      bufferIntervalId = setInterval(() => {
        if (messageBuffer.current.length > 0) {
          setFreshData([...messageBuffer.current]);
          setData((prev) => [...prev, ...messageBuffer.current]);
          setLatestData(
            messageBuffer.current[messageBuffer.current.length - 1]
          );
          messageBuffer.current = [];
        }
      }, bufferInterval);
    }

    return () => {
      if (bufferIntervalId) clearInterval(bufferIntervalId);
    };
  }, [bufferInterval]);

  return {
    data,
    latestData,
    freshData,
    error,
    isReady,
  } as InngestSubsription<TToken>;
}
