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

  /**
   * Which stream of a multi-event subscription delivered it, as the index in
   * `events`, and the position in that stream. Absent on a put-back trigger.
   */
  source?: { stream: number; seq: number };
}

/**
 * One event a subscription listens for.
 */
export interface SubscribeEvent {
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
 * One event, or several in `events`. Several events are several parallel
 * single-event subscriptions under the hood, each with its own numbered
 * messages, and `next()` hands out whichever message arrived first (a race;
 * the order across events is arrival order as the race sees it, and strict
 * ordering across events is not guaranteed).
 */
export type SubscribeOptions = SubscribeEvent | { events: SubscribeEvent[] };

/**
 * The key of stream `index` of a subscription with `count` streams. A single
 * stream uses the subscription key itself.
 * @param key The subscription ID.
 * @param count How many streams.
 * @param index The stream.
 */
export function streamKey(key: string, count: number, index: number): string {
  return count === 1 ? key : `${key}:${index}`;
}

/**
 * The streams of the options, one per event.
 * @param opts Subscription options.
 */
export function streamsOf(opts: SubscribeOptions): SubscribeEvent[] {
  const streams = "events" in opts ? opts.events : [opts];

  if (streams.length === 0) {
    throw new Error("`step.subscribe()` needs at least one event.");
  }

  return streams;
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
   *
   * Pass the message the subscription returned: a hand-built message has no
   * source stream and throws.
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
  seq: number | undefined,
  stream: number,
) => Promise<unknown>;

interface Stream {
  index: number;
  key: string;

  // How many numbered messages of this stream have been read, how many polls
  // it has had, and how many messages it saved once closed.
  read: number;
  polls: number;
  total?: number;

  // The wait for message `seq`, kept until it is consumed so that every
  // `next()` that races this stream waits on the same step.
  pending?: { seq: number; wait: Promise<{ stream: Stream; data: unknown }> };
}

/**
 * Opens a subscription: one stream per event, merged into one message
 * sequence.
 * @param op Runs one subscription op as a step.
 * @param key The subscription ID; prefix of every step it runs.
 * @param opts Subscription options.
 */
export async function openSubscription<TData = unknown>(
  op: SubscribeOp,
  key: string,
  opts: SubscribeOptions,
): Promise<Subscription<TData>> {
  const events = streamsOf(opts);
  const streams: Stream[] = events.map((_event, index) => {
    return {
      index,
      key: streamKey(key, events.length, index),
      read: 0,
      polls: 0,
    };
  });

  for (const stream of streams) {
    await op(`${stream.key}:open`, "open", undefined, stream.index);
  }

  // The position in the merged sequence, which is what callers ack by.
  let delivered = 0;

  // Messages put back, oldest first.
  const held: InboxMessage<TData>[] = [];
  const acked = new Set<number>();

  function drained(stream: Stream) {
    return stream.total !== undefined && stream.read >= stream.total;
  }

  // The ack tells the executor a message was handled, so a message that was
  // saved but never acked is handed to the thread's next run. The trigger
  // (seq 0) is not a saved message. Acks reach each stream in its own order
  // as long as the caller acks in merged order.
  async function ack(message: InboxMessage<TData>) {
    if (message.seq < 1 || acked.has(message.seq)) {
      return;
    }

    if (!message.source) {
      throw new Error(
        `Message ${message.seq} has no source, so it can't be acked: pass the message the subscription returned.`,
      );
    }

    acked.add(message.seq);
    const stream = streams[message.source.stream] as Stream;
    await op(
      `${stream.key}:ack:${message.source.seq}`,
      "ack",
      message.source.seq,
      stream.index,
    );
  }

  function receive(stream: Stream, seq: number, data: unknown) {
    stream.read = seq;
    stream.pending = undefined;
    delivered += 1;

    return {
      seq: delivered,
      data: data as TData,
      source: { stream: stream.index, seq },
    };
  }

  function waitFor(stream: Stream) {
    if (!stream.pending) {
      const seq = stream.read + 1;
      const wait = op(`${stream.key}:${seq}`, "next", seq, stream.index).then(
        (data) => {
          return { stream, data };
        },
      );

      // A wait that loses a race and later fails is not an unhandled error;
      // the next `next()` that races it sees the failure.
      wait.catch(() => {});
      stream.pending = { seq, wait };
    }

    return stream.pending;
  }

  async function next(): Promise<InboxMessage<TData> | null> {
    const waiting = held.shift();
    if (waiting) {
      return waiting;
    }

    const open = streams.filter((stream) => {
      return !drained(stream);
    });
    if (open.length === 0) {
      return null;
    }

    // With several streams the waits race; the winner is the message that
    // arrived first, and the others keep their wait for the next call.
    const waits = open.map((stream) => {
      return waitFor(stream);
    });
    const won = await Promise.race(
      waits.map((wait) => {
        return wait.wait.then((result) => {
          return { ...result, seq: wait.seq };
        });
      }),
    );

    return receive(won.stream, won.seq, won.data);
  }

  async function poll(): Promise<InboxMessage<TData> | null> {
    const waiting = held.shift();
    if (waiting) {
      return waiting;
    }

    for (const stream of streams) {
      if (drained(stream)) {
        continue;
      }

      const seq = stream.read + 1;
      stream.polls += 1;
      const message = await op(
        `${stream.key}:poll:${stream.polls}`,
        "poll",
        seq,
        stream.index,
      );
      if (message !== null && message !== undefined) {
        return receive(stream, seq, message);
      }
    }

    return null;
  }

  return {
    next,
    poll,
    ack,
    putBack(messages) {
      held.unshift(...messages);
    },
    async close() {
      let total = 0;

      for (const stream of streams) {
        const closed = (await op(
          `${stream.key}:close`,
          "close",
          undefined,
          stream.index,
        )) as { count: number };
        stream.total = closed.count;
        total += closed.count;
      }

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
