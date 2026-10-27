/**
 * @module
 * EXPERIMENTAL: `step.subscribe()`, a durable inbox. It is a non-settling wait
 * on a server-side queue: messages sent to the key while the function is busy
 * are held by the server and delivered one at a time, each as its own
 * memoized step, so nothing sent between turns is lost.
 */

/**
 * One delivered inbox message.
 */
export interface InboxMessage<TData = unknown> {
  /**
   * Position in the inbox, starting at 1. Increases by one per message.
   */
  seq: number;
  data: TData;
}

export interface SubscribeOptions {
  /**
   * The inbox to read. Anything sent to this key (see `threads.get(key)`) is
   * delivered here.
   */
  key: string;

  /**
   * How long one wait lasts before the subscription ends. Default `"365d"`.
   */
  timeout?: string | number;
}

/**
 * A subscription to an inbox. Iterate it with `for await`; the loop ends when
 * a wait times out. Each message is a memoized step, so a replay sees the same
 * messages in the same order.
 */
export interface Subscription<TData = unknown>
  extends AsyncIterable<InboxMessage<TData>> {
  /**
   * Waits for the next message, or `null` if the wait timed out.
   */
  next(): Promise<InboxMessage<TData> | null>;
}

/**
 * Waits for one inbox message as a single step.
 */
export type WaitForInbox = (
  id: string,
  opts: { key: string; timeout: string | number },
) => Promise<{ signal: string; data: unknown } | null>;

/**
 * Builds a subscription over a one-message wait.
 * @param wait Waits for a single message as a step.
 * @param id Step ID prefix; every message is a step with this ID.
 * @param opts Subscription options.
 */
export function createSubscription<TData = unknown>(
  wait: WaitForInbox,
  id: string,
  opts: SubscribeOptions,
): Subscription<TData> {
  async function next(): Promise<InboxMessage<TData> | null> {
    const res = await wait(id, {
      key: opts.key,
      timeout: opts.timeout ?? "365d",
    });
    if (!res) {
      return null;
    }

    return res.data as InboxMessage<TData>;
  }

  return {
    next,
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const message = await next();
          if (!message) {
            return { done: true, value: undefined };
          }

          return { done: false, value: message };
        },
      };
    },
  };
}
