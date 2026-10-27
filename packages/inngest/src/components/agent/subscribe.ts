/**
 * @module
 * EXPERIMENTAL: `step.subscribe()`, a durable subscription to events.
 *
 * Opening a subscription asks the executor to keep one pause for the run. The
 * pause is not consumed when an event matches: the executor saves the event as
 * the run's next numbered message and queues a discovery request. Messages
 * that arrive while the function is busy are therefore already in the run's
 * state when it asks for them, and nothing sent between turns is lost.
 *
 * Every read is an ordinary step, so replays, traces and history need nothing
 * special: message k is the step `<id>:<k>`. If the message is already in
 * state the step resolves from memo; otherwise the function waits for it.
 */

/**
 * One delivered message.
 */
export interface InboxMessage<TData = unknown> {
  /**
   * Position in the subscription, starting at 1. A message put back by the
   * trigger event has `seq` 0.
   */
  seq: number;

  /**
   * The event that was sent.
   */
  data: TData;
}

export interface SubscribeOptions {
  /**
   * The event name to subscribe to.
   */
  event: string;

  /**
   * An expression events must match, like the `if` of `step.waitForEvent()`.
   * The event is `async`: `async.data.thread == "t1"`.
   */
  if?: string;
}

/**
 * A subscription. Iterate it with `for await`; the loop ends once it is
 * closed and drained.
 */
export interface Subscription<TData = unknown>
  extends AsyncIterable<InboxMessage<TData>> {
  /**
   * Waits for the next message, or returns `null` once the subscription is
   * closed and every saved message has been read.
   */
  next(): Promise<InboxMessage<TData> | null>;

  /**
   * Reads the next message if it has already arrived, without waiting. Use it
   * between model calls to fold in messages sent while working. Call `ack()`
   * for a message you handle, or `putBack()` one you don't.
   */
  poll(): Promise<InboxMessage<TData> | null>;

  /**
   * Tells the executor a polled message was handled, so it is not handed to
   * the thread's next run. Neither `next()` nor `poll()` acks: ack a message
   * once you have handled it, so a run that fails or is cancelled while
   * handling it leaves it for the next run.
   */
  ack(message: InboxMessage<TData>): Promise<void>;

  /**
   * Puts messages back, in order, so the next reads return them before
   * anything newer. Use it for polled messages that are not yours to handle
   * yet.
   */
  putBack(messages: InboxMessage<TData>[]): void;

  /**
   * Stops the subscription: no new messages are saved. Messages that were
   * saved but not read stay readable, so drain with `next()` until it returns
   * `null` before the function finishes.
   * @returns How many messages the subscription saved in total.
   */
  close(): Promise<number>;
}

/**
 * Runs one op of the subscription as a step.
 */
export type SubscribeOp = (
  stepId: string,
  mode: "open" | "next" | "poll" | "ack" | "close",
  seq?: number,
) => Promise<unknown>;

/**
 * Opens a subscription.
 * @param op Runs one subscription op as a step.
 * @param key The subscription ID; prefix of every step it runs.
 * @param _opts Subscription options (carried by `op`).
 */
export async function openSubscription<TData = unknown>(
  op: SubscribeOp,
  key: string,
  _opts: SubscribeOptions,
): Promise<Subscription<TData>> {
  await op(`${key}:open`, "open");

  // How many numbered messages have been read, and how many exist once closed.
  let read = 0;
  let polls = 0;
  let total: number | undefined;

  // Messages put back, oldest first.
  const held: InboxMessage<TData>[] = [];
  const acked = new Set<number>();

  // The ack tells the executor a message was handled, so a message that was
  // saved but never acked is handed to the thread's next run. The trigger
  // (seq 0) is not a saved message.
  async function ack(message: InboxMessage<TData>) {
    if (message.seq < 1 || acked.has(message.seq)) {
      return;
    }

    acked.add(message.seq);
    await op(`${key}:ack:${message.seq}`, "ack", message.seq);
  }

  function receive(seq: number, message: unknown): InboxMessage<TData> {
    read = seq;

    return { seq, data: message as TData };
  }

  async function next(): Promise<InboxMessage<TData> | null> {
    const waiting = held.shift();
    if (waiting) {
      return waiting;
    }

    if (total !== undefined && read >= total) {
      return null;
    }

    const seq = read + 1;
    return receive(seq, await op(`${key}:${seq}`, "next", seq));
  }

  async function poll(): Promise<InboxMessage<TData> | null> {
    const waiting = held.shift();
    if (waiting) {
      return waiting;
    }

    if (total !== undefined && read >= total) {
      return null;
    }

    const seq = read + 1;
    polls += 1;
    const message = await op(`${key}:poll:${polls}`, "poll", seq);
    if (message === null || message === undefined) {
      return null;
    }

    return receive(seq, message);
  }

  return {
    next,
    poll,
    ack,
    putBack(messages) {
      held.unshift(...messages);
    },
    async close() {
      const closed = (await op(`${key}:close`, "close")) as { count: number };
      total = closed.count;

      return total;
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
