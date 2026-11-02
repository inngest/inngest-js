/**
 * @module
 * EXPERIMENTAL: the thread's view of its inbox: the reader with the agent's
 * rules over a `step.subscribe()` inbox (schema drops, the status the thread
 * records, steering), and the filters that tie a source to the thread.
 */

import type {
  BatchOptions,
  Inbox,
  ReadOptions,
  UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import { addEventIs } from "../../../components/triggers/triggers.ts";
import { asyncDispose } from "../../../helpers/asyncDispose.ts";
import type {
  InboxSource,
  ThreadInbox,
  ThreadInboxMessage,
} from "../agent/types.ts";
import { toAsync } from "../cel.ts";
import {
  agentMessageEvent,
  agentSteerEvent,
  type Inflight,
} from "../threads/thread.ts";
import type { threadRecorder } from "../threads/threadState.ts";
import type { AgentMessageData, AgentResendData } from "./events.ts";

/**
 * The messages whose drop was already logged, so a replay does not log it
 * again.
 */
const warned = new Set<string>();

/**
 * The events the agent layer sends to a thread.
 */
export const ownEvents: string[] = [agentMessageEvent, agentSteerEvent];

/**
 * The message a turn answers, as a failed run resends it, or `undefined` for a
 * message that does not start a turn (a steer).
 * @param event The event.
 */
export const inflightOf = (event: {
  id?: string;
  name: string;
  data: unknown;
}): Inflight | undefined => {
  if (event.name === agentSteerEvent) {
    return undefined;
  }

  if (event.name === agentMessageEvent) {
    const data = event.data as Partial<AgentMessageData & AgentResendData>;

    if (data.event) {
      return { event: data.event };
    }

    return typeof data.text === "string" ? { text: data.text } : undefined;
  }

  return { event: { id: event.id, name: event.name, data: event.data } };
};

/**
 * The inboxes an agent's inbox is made of: the thread's, the one that steers,
 * and how views and listeners are made.
 */
interface ThreadSources {
  /**
   * The thread's inbox.
   */
  inbox: Inbox<UntypedInboxMessage>;
}

/**
 * A reader of an inbox with the agent's rules over it: the surface of an
 * `Inbox`.
 */
export interface Reader<TMessage>
  extends AsyncIterable<TMessage>,
    AsyncDisposable {
  next(): Promise<TMessage | undefined>;
  next(options: ReadOptions): Promise<TMessage | null | undefined>;
  nextBatch(options?: BatchOptions): Promise<TMessage[] | undefined>;
  nextBatch(
    options: BatchOptions & ReadOptions,
  ): Promise<TMessage[] | null | undefined>;
  drain(options?: BatchOptions): Promise<TMessage[]>;
  batches(
    options?: BatchOptions & Partial<ReadOptions>,
  ): AsyncGenerator<TMessage[], void, undefined>;
  close(): Promise<TMessage[]>;
  readonly closed: boolean;
}

/**
 * The thread's view of its inbox: a message is the event as it came.
 */
export function threadInbox(
  sources: ThreadSources,
  problemOf: (raw: RawEvent, started: boolean) => Promise<string | undefined>,

  /**
   * Records the thread's status: `waiting()` before the agent waits for a message after the first, `running()` once one is delivered.
   */
  recorder: Pick<
    ReturnType<typeof threadRecorder>,
    "waiting" | "running" | "resumed"
  >,
  log: { warn: (message: string) => void },
  runId: string,

  // The event that started the run: the inbox's first message, and the one
  // message that is not checked against a schema, because core checked it.
  started?: UntypedInboxMessage,
): {
  inbox: ThreadInbox;
  view: (source: Inbox<UntypedInboxMessage>) => Reader<UntypedInboxMessage>;
  steering: {
    take: () => Promise<ThreadInboxMessage[]>;
    keep: (messages: ThreadInboxMessage[]) => void;
  };
} {
  // The event each message was made from, to leave it unread as it came.
  const raws = new WeakMap<object, UntypedInboxMessage>();

  function unwrap(
    message: UntypedInboxMessage | null,
  ): ThreadInboxMessage | null {
    if (!message) {
      return null;
    }

    // The event stays as it came. An event that recovery sent again is the
    // event it was made from: it keeps its name, id and data.
    const resent =
      message.name === agentMessageEvent
        ? (message.data as Partial<AgentResendData>).event
        : undefined;
    const unwrapped = addEventIs({
      ...message,
      ...(resent
        ? {
            id: resent.id ?? message.id,
            name: resent.name,
            data: resent.data,
          }
        : {}),
    });
    raws.set(unwrapped, message);

    // One cast: the spread above is a plain object, and `ThreadInboxMessage` is
    // a union that depends on the caller's `triggers`, which the runtime
    // cannot derive.
    return unwrapped as unknown as ThreadInboxMessage;
  }

  function rawOf(message: ThreadInboxMessage): UntypedInboxMessage {
    // A message that did not come from `unwrap` is already an event.
    return raws.get(message) ?? (message as unknown as UntypedInboxMessage);
  }

  let delivered = 0;

  // An event that breaks its trigger's schema never starts a run in core, so
  // it does not reach a live one either: it is dropped. The event that started
  // the run was checked by core, except for the payload of a request, which
  // core does not see.
  async function skipped(raw: UntypedInboxMessage) {
    const problem = await problemOf(raw, raw === started);
    if (!problem) {
      return false;
    }

    warnOnce(raw, problem);

    return true;
  }

  // The drop is decided again when the run replays, and the handler's logger
  // is quiet while a run replays, so the warning goes to the client's own
  // logger once per message and process.
  function warnOnce(raw: UntypedInboxMessage, problem: string) {
    const id = `${runId}:${raw.id}`;
    if (warned.has(id)) {
      return;
    }

    // Forget the oldest drop once there are many, so the set stays small.
    if (warned.size >= 1000) {
      warned.delete(warned.values().next().value as string);
    }

    warned.add(id);
    log.warn(
      `Dropped ${raw.name} from the inbox: it breaks its schema (${problem}).`,
    );
  }

  // Messages to return before the source's: the event that started the run,
  // and the ones steering took and left for the next turn. They are rebuilt on
  // every replay, which takes and keeps the same messages.
  const lead: UntypedInboxMessage[] = started ? [started] : [];

  // What is left of messages the source handed over once the ones that break
  // their schema are dropped.
  async function keep(raws: UntypedInboxMessage[]) {
    const kept: UntypedInboxMessage[] = [];

    for (const raw of raws) {
      if (!(await skipped(raw))) {
        kept.push(raw);
      }
    }

    return kept;
  }

  // A reader with the agent's rules over an `Inbox`. Only the main one starts
  // with the event that started the run and records the thread's status.
  function view<TOut>(
    source: Inbox<UntypedInboxMessage>,
    present: (raw: UntypedInboxMessage) => TOut,
    main: boolean,
  ): Reader<TOut> {
    const first = main ? lead : [];

    const reader: Reader<TOut> = {
      next: (async (options?: ReadOptions) => {
        if (main && delivered > 0) {
          await recorder.waiting();
        }

        for (;;) {
          const queued = first.shift();

          // The trigger comes from the run's state: it still gets its row.
          if (queued && main && queued === started) {
            source.noteStart();
          }

          const raw =
            queued ??
            (options ? await source.next(options) : await source.next());

          if (raw === undefined) {
            return undefined;
          }

          if (raw === null) {
            // The wait expired: the agent goes on working, so it is not waiting.
            if (main && delivered > 0) {
              await recorder.resumed();
            }

            return null;
          }

          if (await skipped(raw)) {
            continue;
          }

          if (!main) {
            return present(raw);
          }

          const message = present(raw);

          delivered += 1;

          if (delivered > 1) {
            await recorder.running(
              undefined,
              inflightOf(message as unknown as ThreadInboxMessage),
            );
          }

          return message;
        }
      }) as Reader<TOut>["next"],
      nextBatch: (async (options?: BatchOptions & Partial<ReadOptions>) => {
        if (main && delivered > 0) {
          await recorder.waiting();
        }

        for (;;) {
          const queued = first.splice(0);
          let raws: UntypedInboxMessage[];

          if (queued.length > 0) {
            raws = [...queued, ...(await source.drain(options))];
          } else {
            const got = await source.nextBatch(
              options as BatchOptions & ReadOptions,
            );

            if (got === undefined) {
              return got;
            }

            if (got === null) {
              // The wait expired: the agent goes on working, so it is not waiting.
              if (main && delivered > 0) {
                await recorder.resumed();
              }

              return got;
            }

            raws = got;
          }

          const kept = await keep(raws);
          if (kept.length > 0) {
            const batch = kept.map(present);

            if (!main) {
              return batch;
            }

            delivered += batch.length;

            // The thread resends one message when a failed run recovers: the
            // last one of the batch that starts a turn.
            let inflight: Inflight | undefined;

            for (const message of batch) {
              inflight =
                inflightOf(message as unknown as ThreadInboxMessage) ??
                inflight;
            }

            if (delivered > 1) {
              await recorder.running(undefined, inflight);
            }

            return batch;
          }
        }
      }) as Reader<TOut>["nextBatch"],
      async *batches(options?: BatchOptions & Partial<ReadOptions>) {
        for (;;) {
          const batch = await reader.nextBatch(
            options as BatchOptions & ReadOptions,
          );

          if (batch === undefined || batch === null) {
            return;
          }

          yield batch;
        }
      },
      async drain(options?: BatchOptions) {
        const raws = [...first.splice(0), ...(await source.drain(options))];

        return (await keep(raws)).map(present);
      },
      async close() {
        const raws = [...first.splice(0), ...(await source.close())];

        return (await keep(raws)).map(present);
      },
      get closed() {
        return source.closed;
      },
      async [asyncDispose]() {
        await source.close();
      },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const message = await reader.next();

            return message === undefined
              ? { done: true, value: undefined }
              : { done: false, value: message };
          },
        };
      },
    };

    return reader;
  }

  const plain = (raw: UntypedInboxMessage) => {
    return addEventIs({ ...raw });
  };
  const main = view(
    sources.inbox,
    (raw) => {
      return unwrap(raw) as ThreadInboxMessage;
    },
    true,
  );

  return {
    inbox: main as unknown as ThreadInbox,
    view: (source: Inbox<UntypedInboxMessage>) => {
      return view(source, plain, false);
    },
    steering: {
      async take() {
        const raws = await keep([
          ...lead.splice(0),
          ...(await sources.inbox.drain()),
        ]);

        return raws.map((raw) => {
          return unwrap(raw) as ThreadInboxMessage;
        });
      },
      keep(messages) {
        lead.unshift(...messages.map(rawOf));
      },
    },
  };
}

/**
 * An event as the subscription saves it.
 */
export interface RawEvent {
  id?: string;
  name: string;
  data: unknown;
  stream?: number;
}

export function quote(value: string) {
  return JSON.stringify(value);
}

/**
 * The subscription source of an inbox source: its `if` and `thread`
 * expressions (over `event`) turned into one filter over `async` that also
 * ties it to the thread.
 * @param source The inbox source.
 * @param thread The thread key of the run.
 */
export function inboxFilter(
  source: { if?: string; thread?: string },
  thread: string,
) {
  const conditions = [
    source.if && `(${source.if})`,
    source.thread && `(${toAsync(source.thread)}) == ${quote(thread)}`,
  ].filter((condition): condition is string => {
    return Boolean(condition);
  });

  if (conditions.length === 0) {
    throw new Error("An inbox source needs a `thread` or an `if`.");
  }

  return conditions.join(" && ");
}

/**
 * The name of an event source.
 * @param source A name or an event type.
 */
export function eventNameOf(source: InboxSource["event"]): string {
  return typeof source === "string" ? source : source.name;
}
