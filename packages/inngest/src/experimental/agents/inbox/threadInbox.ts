/**
 * @module
 * EXPERIMENTAL: the thread's view of its inbox: the reader with the agent's
 * rules over a `step.subscribe()` inbox (schema drops, the status the thread
 * records), and the filters that tie a source to the thread.
 */

import { stepsIssued } from "../../../components/execution/als.ts";
import {
  type BatchOptions,
  type Inbox,
  inboxHasUnread,
  type ReadOptions,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import { addEventIs } from "../../../components/triggers/triggers.ts";
import { asyncDispose } from "../../../helpers/asyncDispose.ts";
import { internalEvents } from "../../../helpers/consts.ts";
import type { AgentMessage, InboxSource } from "../agent/types.ts";
import { compileKey, toAsync } from "../cel.ts";
import {
  agentAnswerEvent,
  agentFinishedEvent,
  agentMessageEvent,
  agentQuestionEvent,
  agentRecoverEvent,
  type Inflight,
} from "../threads/thread.ts";
import type { threadRecorder } from "../threads/threadState.ts";
import type { Answer } from "./answer.ts";
import type {
  AgentMessageData,
  AgentQuestionData,
  AgentRecoverData,
  SenderData,
} from "./events.ts";
import {
  isReportMessage,
  reportDataProblem,
  reportWireEvent,
  reservedReportType,
  routingKey,
  routingOf,
  withoutRouting,
} from "./reports.ts";

/**
 * The messages whose drop was already logged, so a replay does not log it
 * again.
 */
const warned = new Set<string>();

/**
 * The events the agent layer sends to a thread.
 */
export const ownEvents: string[] = [
  agentMessageEvent,
  agentRecoverEvent,
  agentQuestionEvent,
  agentAnswerEvent,
  agentFinishedEvent,
  reportWireEvent,
];

/**
 * Whether an event is one the agent layer sends to a thread, including a
 * typed report.
 */
export const isOwnEvent = (name: string): boolean => {
  return ownEvents.includes(name);
};

/**
 * The message a turn answers, as a failed run resends it, or `undefined` for a
 * message that does not start a turn.
 * @param event The event.
 */
export const inflightOf = (event: {
  id?: string;
  name: string;
  data: unknown;
}): Inflight | undefined => {
  if (event.name === agentRecoverEvent) {
    const data = event.data as Partial<AgentRecoverData>;

    return data.event ? { event: data.event } : undefined;
  }

  if (event.name === agentMessageEvent) {
    const data = event.data as Partial<AgentMessageData>;

    // The message's ID and sender are kept with its text, so a resend is the
    // same message: its sender hears how the run ended, and the run that takes
    // it up knows who sent it.
    return data.content === undefined
      ? undefined
      : {
          content: data.content,
          ...(event.id !== undefined && { id: event.id }),
          ...(data.from !== undefined && { from: data.from }),
        };
  }

  return { event: { id: event.id, name: event.name, data: event.data } };
};

/**
 * The messages that can carry a sender in `data.from`.
 */
const senderMessages: string[] = [
  agentMessageEvent,
  agentQuestionEvent,
  agentAnswerEvent,
  agentFinishedEvent,
];

/**
 * The IDs of the `agent/message` events among messages the run took in after
 * the one that started it, whose senders wait for the run's result.
 */
const senderIds = (
  messages: { id?: string; name: string }[],
  started?: { id?: string },
): string[] => {
  return messages.flatMap((message) => {
    return message.name === agentMessageEvent &&
      message.id &&
      message.id !== started?.id
      ? [message.id]
      : [];
  });
};

/**
 * A message as the agent sees it. The event stays as it came; an event that
 * recovery sent again is the event it was made from, with its own name, id and
 * data. It has `is()`.
 * @param message The message as it was saved.
 */
export const resentAs = (message: UntypedInboxMessage): UntypedInboxMessage => {
  const resent =
    message.name === agentRecoverEvent
      ? (message.data as Partial<AgentRecoverData>).event
      : undefined;
  const as = {
    ...message,
    ...(resent
      ? {
          id: resent.id ?? message.id,
          name: resent.name,
          data: resent.data,
        }
      : {}),
  };
  // A report is sent with its routing around it; the message is the report's
  // own data under its type's name, with the sender beside it as `from` and
  // what it relies on in `report`.
  if (as.name === reportWireEvent) {
    const routing = routingOf(as.data);

    if (
      typeof routing?.type === "string" &&
      !reservedReportType(routing.type)
    ) {
      return addEventIs({
        ...as,
        name: routing.type,
        data: withoutRouting(as.data),
        ...(routing.from !== undefined && { from: routing.from }),
        report: {
          ...(routing.grant !== undefined && { grant: routing.grant }),
          ...(routing.pop !== undefined && { pop: routing.pop }),
        },
      } as UntypedInboxMessage);
    }

    return addEventIs(as);
  }

  const data = as.data as
    | { content?: unknown; from?: { typed?: boolean } }
    | undefined;

  // The message `start()` sends to an agent with an `invoke()` trigger carries
  // the typed input as its content; the run's event has the trigger's shape.
  if (as.name === agentMessageEvent && data?.from?.typed === true) {
    return addEventIs({
      ...as,
      name: internalEvents.FunctionInvoked,
      data: data.content,
    } as UntypedInboxMessage);
  }

  return addEventIs(as);
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

  /**
   * Internal: what a loop's fold takes before a model call. The first call
   * after `batches()` handed out a batch takes nothing, since the batch was
   * just read; the next turn's fold picks up what arrived since.
   */
  "~fold"?: (turn: number) => Promise<TMessage[]>;
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
    "waiting" | "running" | "resumed" | "folded"
  >,
  log: { warn: (message: string) => void },
  runId: string,

  // The event that started the run: the inbox's first message, and the one
  // message that is not checked against a schema, because core checked it.
  started?: UntypedInboxMessage,

  // How long the loop forms (`for await` over the inbox or its batches) wait
  // in quiet before they end, in milliseconds. 0 ends them the moment they
  // would have to wait, as in a run opened through a handle. Left out, they
  // wait for ever.
  idle?: number,

  // The children the run started with `start_agent` that are still open.
  children?: {
    open: () => string[];
    settle: (key: string) => void;
    wait: () => number;
  },

  // Makes `msg.from` of a message that has a sender.
  senderFor?: (from: SenderData) => unknown,

  // Answers a question that reached the inbox.
  answer?: (
    question: { data: { id: string; text?: string; from?: SenderData } },
    answer: Answer,
  ) => Promise<void>,

  // Told of each question that reaches the inbox, so the run can answer it
  // later by its ID.
  noteQuestion?: (data: AgentQuestionData) => void,

  // Reads the thread's inbox in the background: one read waits for messages
  // for the life of the run, beside the work, and what it brings goes to a
  // queue. `batches()` and the fold take from the queue, so they cost no step
  // of their own. `sleep` times the wait for `idle`.
  background?: {
    sleep: (id: string, ms: number) => Promise<unknown>;
  },
): {
  inbox: Inbox<AgentMessage>;
  view: (source: Inbox<UntypedInboxMessage>) => Reader<UntypedInboxMessage>;
} {
  function unwrap(message: UntypedInboxMessage | null): AgentMessage | null {
    if (!message) {
      return null;
    }

    const unwrapped = resentAs(message);

    // A report narrows to its type only when its data fits that type's own
    // schema: the sender wrote the data, and it is not trusted until then.
    if (isReportMessage(unwrapped)) {
      const checkedIs = (unwrapped as { is: (types: unknown) => boolean }).is;

      Object.defineProperty(unwrapped, "is", {
        value: (types: { name: string } | readonly { name: string }[]) => {
          const list = Array.isArray(types) ? types : [types];

          return list.some((type: { name: string }) => {
            if (!checkedIs([type])) {
              return false;
            }

            const problem = reportDataProblem(type, unwrapped.data);

            if (problem) {
              warnOnce(message, problem);
            }

            return problem === undefined;
          });
        },
        enumerable: false,
        configurable: true,
      });
    }

    const sender = isReportMessage(unwrapped)
      ? (unwrapped as { from?: SenderData }).from
      : (unwrapped.data as { from?: SenderData } | undefined)?.from;

    if (
      sender &&
      senderFor &&
      (senderMessages.includes(unwrapped.name) || isReportMessage(unwrapped))
    ) {
      Object.assign(unwrapped, { from: senderFor(sender) });
    }

    if (unwrapped.name === agentQuestionEvent && answer) {
      const data = unwrapped.data as AgentQuestionData;

      noteQuestion?.(data);

      Object.assign(unwrapped, {
        reply: (given: string | { outcome: "refused" }) => {
          return answer(
            { data },
            typeof given === "string" ? { text: given } : given,
          );
        },
      });
    }

    // One cast: the spread above is a plain object, and `AgentMessage` is
    // a union that depends on the caller's `triggers`, which the runtime
    // cannot derive.
    return unwrapped as unknown as AgentMessage;
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

  // Messages to return before the source's: the event that started the run.
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

  // A child's `agent/finished` that reaches the run closes that child.
  function settleChildren(messages: unknown[]) {
    for (const message of messages as {
      name?: string;
      data?: { from?: { key?: unknown } };
    }[]) {
      const key = message.data?.from?.key;

      if (message.name === agentFinishedEvent && typeof key === "string") {
        children?.settle(key);
      }
    }
  }

  // A drain takes messages in without starting a turn, so their IDs are noted
  // on their own.
  async function noteFolded(taken: unknown[], main: boolean) {
    const ids = main
      ? senderIds(taken as { id?: string; name: string }[], started)
      : [];

    if (ids.length > 0) {
      await recorder.folded(ids);
    }
  }

  // A reader with the agent's rules over an `Inbox`. Only the main one starts
  // with the event that started the run and records the thread's status.
  function view<TOut>(
    source: Inbox<UntypedInboxMessage>,
    present: (raw: UntypedInboxMessage) => TOut,
    main: boolean,
  ): Reader<TOut> {
    const first = main ? lead : [];

    // How long the loop forms wait in quiet now. A run that waits for no time
    // still waits, up to the bound, while a child it started with
    // `start_agent` is open: that child's `agent/finished` folds in.
    const quietNow = () => {
      if (!main) {
        return undefined;
      }

      return idle === 0 && children && children.open().length > 0
        ? children.wait()
        : idle;
    };

    // How many steps the run's code had called when this reader last read the
    // source. A drain with no step since finds nothing new, so it is skipped.
    // The count is the same on a replay, so the skip is too.
    let readAt: number | undefined;
    const noteRead = () => {
      readAt = stepsIssued();
    };
    // Whether `batches()` handed out a batch the fold has not yet followed.
    let batchGiven = false;
    const drainSource = async (options?: BatchOptions) => {
      const now = stepsIssued();

      if (now !== undefined && now === readAt && options?.max === undefined) {
        return [];
      }

      const raws = await source.drain(options);

      batchGiven = false;
      noteRead();

      return raws;
    };

    // The background reader of the main view. One read of the source waits at
    // a time and the batch it brings goes to a queue. Everything else the
    // thread does with those messages (schema drops, the thread's status,
    // children) happens where the queue is taken, in the order the run's code
    // takes it, so a replay does it at the same places. A batch lands in the
    // queue where its answer sits in the run's state.
    //
    // A read is issued only where the run's code is about to do work of its
    // own (just before a model call) or to wait, never between: a read found
    // while the code goes on to other asynchronous work would be reported
    // alone, and the run would sit on it.
    const bg =
      main && background
        ? {
            queue: [] as UntypedInboxMessage[],
            reading: false,
            ended: false,
            failure: undefined as { error: unknown } | undefined,
            waiters: [] as (() => void)[],
            idleWaits: 0,
          }
        : undefined;

    const bgWake = () => {
      for (const resolve of bg?.waiters.splice(0) ?? []) {
        resolve();
      }
    };

    // Makes sure a read is waiting for messages.
    const bgArm = () => {
      if (!bg || bg.reading || bg.ended) {
        return;
      }

      bg.reading = true;

      source.nextBatch().then(
        (got) => {
          bg.reading = false;

          if (got === undefined) {
            bg.ended = true;
          } else {
            bg.queue.push(...got);
          }

          bgWake();
        },
        (error) => {
          bg.reading = false;
          bg.failure = { error };
          bg.ended = true;
          bgWake();
        },
      );
    };

    // Settles once the queue has something or the source has ended.
    const bgArrival = (): Promise<void> => {
      if (!bg || bg.queue.length > 0 || bg.ended) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        bg.waiters.push(resolve);
      });
    };

    // What the queue held, with the messages that break their schema dropped.
    const bgTake = async (): Promise<UntypedInboxMessage[]> => {
      return keep([...first.splice(0), ...(bg?.queue.splice(0) ?? [])]);
    };

    // Waits for something to take, or says the loop ends: a run with no quiet
    // to wait ends the moment nothing is queued or saved unread, `idle` of
    // quiet ends it, and the source closing ends it.
    const bgWait = async (): Promise<boolean> => {
      if (!bg || !background) {
        return false;
      }

      if (bg.failure) {
        throw bg.failure.error;
      }

      const quiet = quietNow();

      if (quiet === 0) {
        // A message saved in the run's state that the reader has not handed
        // over yet is on its way: wait for it.
        if (!bg.ended && inboxHasUnread(source)) {
          bgArm();
          await bgArrival();

          return true;
        }

        return false;
      }

      if (bg.ended) {
        return false;
      }

      if (delivered > 0) {
        await recorder.waiting();
      }

      bgArm();

      if (quiet === undefined) {
        await bgArrival();

        return !bg.ended || bg.queue.length > 0;
      }

      bg.idleWaits += 1;

      const timedOut = await Promise.race([
        bgArrival().then(() => {
          return false;
        }),
        background.sleep(`inbox:idle:${bg.idleWaits}`, quiet).then(() => {
          return true;
        }),
      ]);

      if (timedOut) {
        // The wait expired: the agent goes on working, so it is not waiting.
        if (delivered > 0) {
          await recorder.resumed();
        }

        return false;
      }

      return true;
    };

    // The next batch for a loop: what is queued, else what the wait brings.
    const bgBatch = async (): Promise<TOut[] | undefined> => {
      for (;;) {
        const kept = await bgTake();

        if (kept.length === 0) {
          if (bg?.queue.length === 0 && !(await bgWait())) {
            return undefined;
          }

          continue;
        }

        const batch = kept.map(present);

        delivered += batch.length;
        settleChildren(batch);

        // The thread resends one message when a failed run recovers: the last
        // one of the batch that starts a turn.
        let inflight: Inflight | undefined;

        for (const message of batch) {
          inflight = inflightOf(message as unknown as AgentMessage) ?? inflight;
        }

        if (delivered > 1) {
          await recorder.running(
            undefined,
            inflight,
            undefined,
            undefined,
            senderIds(batch as unknown as { name: string }[], started),
          );
        }

        return batch;
      }
    };

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

          if (!queued) {
            noteRead();
          }

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
          settleChildren([message]);

          if (delivered > 1) {
            await recorder.running(
              undefined,
              inflightOf(message as unknown as AgentMessage),
              undefined,
              undefined,
              senderIds([message as unknown as { name: string }], started),
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
            raws = [...queued, ...(await drainSource(options))];
          } else {
            const got = await source.nextBatch(
              options as BatchOptions & ReadOptions,
            );

            noteRead();

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
            settleChildren(batch);

            // The thread resends one message when a failed run recovers: the
            // last one of the batch that starts a turn.
            let inflight: Inflight | undefined;

            for (const message of batch) {
              inflight =
                inflightOf(message as unknown as AgentMessage) ?? inflight;
            }

            if (delivered > 1) {
              await recorder.running(
                undefined,
                inflight,
                undefined,
                undefined,
                senderIds(batch as unknown as { name: string }[], started),
              );
            }

            return batch;
          }
        }
      }) as Reader<TOut>["nextBatch"],
      async *batches(options?: BatchOptions & Partial<ReadOptions>) {
        if (bg) {
          for (;;) {
            const batch = await bgBatch();

            if (batch === undefined) {
              return;
            }

            yield batch;
          }
        }

        for (;;) {
          const quiet = quietNow();

          // `idle` ends the loop after that much quiet. A timeout of the
          // caller's own wins.
          const batch =
            quiet === 0 && options?.timeout === undefined
              ? await reader.drain(options)
              : await reader.nextBatch(
                  (quiet !== undefined && options?.timeout === undefined
                    ? { ...options, timeout: quiet }
                    : options) as BatchOptions & ReadOptions,
                );

          if (quiet === 0 && options?.timeout === undefined) {
            if (batch === undefined || batch.length === 0) {
              return;
            }

            batchGiven = true;
            yield batch;
            continue;
          }

          if (batch === undefined || batch === null) {
            return;
          }

          batchGiven = true;
          yield batch;
        }
      },
      async "~fold"(turn: number) {
        if (bg) {
          const taken = (await bgTake()).map(present);

          await noteFolded(taken, main);
          settleChildren(taken);

          // The model call follows at once: the read waits beside it.
          bgArm();

          return taken;
        }

        if (turn === 1 && batchGiven && first.length === 0) {
          batchGiven = false;

          return [];
        }

        return reader.drain();
      },
      async drain(options?: BatchOptions) {
        const raws = [...first.splice(0), ...(await drainSource(options))];
        const taken = (await keep(raws)).map(present);

        await noteFolded(taken, main);

        if (main) {
          settleChildren(taken);
        }

        return taken;
      },
      async close() {
        const raws = [
          ...first.splice(0),
          ...(bg?.queue.splice(0) ?? []),
          ...(await source.close()),
        ];
        const taken = (await keep(raws)).map(present);

        await noteFolded(taken, main);

        return taken;
      },
      get closed() {
        return source.closed;
      },
      async [asyncDispose]() {
        await source.close();
      },
      [Symbol.asyncIterator]() {
        // With an `idle` of 0 the loop yields what is unread and ends.
        const waiting: TOut[] = [];

        return {
          async next() {
            const quiet = quietNow();

            if (quiet === 0 || (waiting.length > 0 && main)) {
              if (waiting.length === 0) {
                waiting.push(...(await reader.drain()));
              }

              const message = waiting.shift();

              return message === undefined
                ? { done: true, value: undefined }
                : { done: false, value: message };
            }

            const message =
              quiet === undefined
                ? await reader.next()
                : await reader.next({ timeout: quiet });

            return message === undefined || message === null
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
      return unwrap(raw) as AgentMessage;
    },
    true,
  );

  return {
    inbox: main as unknown as Inbox<AgentMessage>,
    view: (source: Inbox<UntypedInboxMessage>) => {
      return view(source, plain, false);
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
 * The path in a CEL expression to the routing fields of an own event: the
 * data itself, or for a report the reserved key, which only a bracket reaches.
 * @param name The event's name.
 * @param root `event` or `async`.
 */
const routingPath = (name: string, root: "event" | "async"): string => {
  return name === reportWireEvent
    ? `${root}.data[${quote(routingKey)}]`
    : `${root}.data`;
};

/**
 * The condition under which an own event starts a run of an agent: it is for
 * that agent, and not `quiet`.
 * @param name The event's name.
 * @param ref The agent, as `"appId/functionId"`.
 */
export const ownTriggerFilter = (name: string, ref: string): string => {
  const path = routingPath(name, "event");

  return name === reportWireEvent
    ? `${path}.agent == ${quote(ref)}`
    : `${path}.agent == ${quote(ref)} && ${path}.quiet != true`;
};

/**
 * The condition under which an own event belongs to one thread's inbox.
 * @param name The event's name.
 * @param ref The agent, as `"appId/functionId"`.
 * @param thread The thread's key.
 */
export const ownInboxFilter = (
  name: string,
  ref: string,
  thread: string,
): string => {
  const path = routingPath(name, "async");

  return `${path}.agent == ${quote(ref)} && ${path}.thread == ${quote(thread)}`;
};

/**
 * The CEL for the thread an own event names, over `event`.
 * @param name The event's name.
 */
export const ownThreadPath = (name: string): string => {
  return `${routingPath(name, "event")}.thread`;
};

/**
 * The subscription source of an inbox source: its `if` and `thread`
 * expressions (over `event`) turned into one filter over `async` that also
 * ties it to the thread. The source's own `thread` wins over `agentThread`,
 * the agent-wide expression. An event with nothing at the thread path matches
 * nothing, so it reaches no thread.
 * @param source The inbox source.
 * @param thread The thread key of the run.
 * @param agentThread The agent-wide thread expression.
 */
export function inboxFilter(
  source: { if?: string; thread?: string },
  thread: string,
  agentThread?: string,
) {
  const expression = source.thread ?? agentThread;
  const present = expression ? toAsync(compileKey(expression).present) : "true";
  const conditions = [
    present !== "true" && `(${present})`,
    source.if && `(${source.if})`,
    expression && `(${toAsync(expression)}) == ${quote(thread)}`,
  ].filter((condition): condition is string => {
    return Boolean(condition);
  });

  if (!expression && !source.if) {
    throw new Error("An inbox source needs a `thread` or an `if`.");
  }

  return conditions.join(" && ");
}

/**
 * The subscription source that catches the events of an inbox source with
 * nothing at its thread path, so the run can drop them with a warning. It is
 * `undefined` for a source whose thread path is always there.
 * @param source The inbox source.
 * @param agentThread The agent-wide thread expression.
 */
export function missingThreadFilter(
  source: { if?: string; thread?: string },
  agentThread?: string,
): string | undefined {
  const expression = source.thread ?? agentThread;
  const present = expression ? toAsync(compileKey(expression).present) : "true";

  if (present === "true") {
    return undefined;
  }

  return [`!(${present})`, source.if && `(${source.if})`]
    .filter((condition): condition is string => {
      return Boolean(condition);
    })
    .join(" && ");
}

/**
 * The name of an event source.
 * @param source A name or an event type.
 */
export function eventNameOf(source: InboxSource["event"]): string {
  return typeof source === "string" ? source : source.name;
}
