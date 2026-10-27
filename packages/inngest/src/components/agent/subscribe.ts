/**
 * @module
 * EXPERIMENTAL: `step.subscribe()`, a durable inbox. It is a non-settling wait
 * on a queue: messages sent to the key while the function is busy are held in
 * the store and delivered one at a time, each as its own memoized step, so
 * nothing sent between turns is lost.
 *
 * Reading is a step that claims the next message from the store. When there
 * is none, the function waits on a signal (the doorbell) that senders ring
 * after appending, then reads again. The wait has a recheck timeout, so a
 * missed doorbell delays a message by one interval and never loses it.
 */
import type { InboxMessage, InboxStore } from "./inbox.ts";

export type { InboxMessage } from "./inbox.ts";

/**
 * The signal a sender rings to wake a reader of `key`.
 * @param key Inbox key.
 */
export function doorbellSignal(key: string): string {
  return `inbox:${key}`;
}

export interface SubscribeOptions {
  /**
   * The inbox to read. Anything sent to this key (see `threads.get(key)`) is
   * delivered here.
   */
  key: string;

  /**
   * How long one empty wait lasts before the inbox is read again. Default
   * `"5m"`. It only bounds the cost of a missed doorbell.
   */
  recheck?: string | number;

  /**
   * End the subscription after this many empty rechecks in a row. Default:
   * never.
   */
  maxRechecks?: number;

  /**
   * Where messages live. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  store?: InboxStore;
}

/**
 * A subscription to an inbox. Iterate it with `for await`. Each message is a
 * memoized step, so a replay sees the same messages in the same order.
 */
export interface Subscription<TData = unknown>
  extends AsyncIterable<InboxMessage<TData>> {
  /**
   * Waits for the next message, or `null` once `maxRechecks` empty rechecks
   * have passed.
   */
  next(): Promise<InboxMessage<TData> | null>;

  /**
   * The next message without claiming it, or `null`. Use it to decide
   * whether to take the message now.
   */
  peek(): Promise<InboxMessage<TData> | null>;

  /**
   * Whether a message is waiting, without waiting for one. Use it between
   * model calls to fold in messages that arrived while working.
   */
  pending(): Promise<boolean>;
}

/**
 * The step tools a subscription is built from.
 */
export interface SubscribeDeps {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
  waitForSignal: (
    id: string,
    opts: {
      signal: string;
      timeout: string | number;
      onConflict: "replace" | "fail";
    },
  ) => Promise<unknown>;
  store: () => InboxStore;
  runId: () => string;
}

/**
 * Builds a subscription.
 * @param deps Step tools, the store and the run ID.
 * @param id Step ID prefix.
 * @param opts Subscription options.
 */
export function createSubscription<TData = unknown>(
  deps: SubscribeDeps,
  id: string,
  opts: SubscribeOptions,
): Subscription<TData> {
  const store = () => opts.store ?? deps.store();
  let reads = 0;

  async function next(): Promise<InboxMessage<TData> | null> {
    let empty = 0;

    for (;;) {
      reads += 1;
      const owner = `${deps.runId()}:${id}:${reads}`;
      const message = (await deps.run(`${id}:read`, async () => {
        return store().claim(opts.key, owner);
      })) as InboxMessage<TData> | null;

      if (message) {
        return message;
      }

      const rung = await deps.waitForSignal(`${id}:wait`, {
        signal: doorbellSignal(opts.key),
        timeout: opts.recheck ?? "5m",
        onConflict: "replace",
      });
      empty = rung ? 0 : empty + 1;

      if (opts.maxRechecks !== undefined && empty >= opts.maxRechecks) {
        return null;
      }
    }
  }

  return {
    next,
    async peek() {
      return (await deps.run(`${id}:peek`, async () => {
        return store().peek(opts.key);
      })) as InboxMessage<TData> | null;
    },
    async pending() {
      return (await deps.run(`${id}:pending`, async () => {
        const { head, acked } = await store().cursors(opts.key);

        return head > acked;
      })) as boolean;
    },
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
