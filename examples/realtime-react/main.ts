import { Inngest } from "inngest";
import { channel, topic, type Realtime } from "inngest/experimental";
import { useEffect, useRef, useState } from "react";

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
    string)[] = (keyof Realtime.Channel.InferTopics<
    Realtime.Channel.AsChannel<InputChannel>
  > &
    string)[],
  const TToken extends Realtime.Subscribe.Token<
    Realtime.Channel.AsChannel<InputChannel>,
    InputTopics
  > = Realtime.Subscribe.Token<
    Realtime.Channel.AsChannel<InputChannel>,
    InputTopics
  >,
>({
  app,
  channel,
  topics,
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
  enabled?: boolean;

  /**
   * TODO
   */
  bufferInterval?: number;

  /**
   * TODO
   */
}): {
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
} {
  const [data, setData] = useState<
    Realtime.Subscribe.Token.InferMessage<TToken>[]
  >([]);
  const [latestData, setLatestData] =
    useState<Realtime.Subscribe.Token.InferMessage<TToken> | null>(null);
  const [freshData, setFreshData] = useState<
    Realtime.Subscribe.Token.InferMessage<TToken>[]
  >([]);
  const [error, setError] = useState<Error | null>(null);
  const [isReady, setIsReady] = useState(false);
  const subscriptionRef = useRef<Realtime.Subscribe.StreamSubscription | null>(
    null
  );
  const messageBuffer = useRef<Realtime.Subscribe.Token.InferMessage<TToken>[]>(
    []
  );
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
        const stream = await app.subscribe({ channel, topics });
        subscriptionRef.current = stream;
        setIsReady(true);

        for await (const message of stream) {
          if (!isMountedRef.current) break;

          if (bufferIntervalRef.current === 0) {
            setFreshData([message.data]);
            setData((prev) => [...prev, message.data]);
            setLatestData(message.data);
          } else {
            messageBuffer.current.push(message.data);
          }
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        setError(err);
      }
    };

    subscribe();

    return () => {
      isMountedRef.current = false;
      subscriptionRef.current?.close();
    };
  }, [app, channel, topics, enabled]);

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

  return { data, latestData, freshData, error, isReady };
}

const app = new Inngest({ id: "fe" });

const ch = channel((userId) => `user:${userId}`)
  .addTopic(topic("a").type<boolean>())
  .addTopic(topic("b").type<{ foo: number }>());

const result = useInngestSubscription({
  app,
  channel: ch("123"),
  topics: ["a", "b"],
});

const token = await app.getSubscriptionToken({
  channel: ch("123"),
  topics: ["a", "b"],
});

const resulta = useInngestSubscription<typeof ch>({
  app,
  channel: "user:123",
  topics: ["b"]
});
