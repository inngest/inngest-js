/**
 * @module
 * EXPERIMENTAL: the thread run. **Two** Inngest functions per agent
 * definition, because one function cannot both be woken by arrivals and be
 * replaced without being blocked by itself.
 *
 * - **The supervisor** (`<agent>-thread`) triggers on everything that reaches
 *   a thread, under `singleton: { key: <thread>, mode: "skip" }` - a plain
 *   thread key, which is the only thing an arriving event can be keyed on,
 *   since the key is evaluated before any code runs. It holds no state and
 *   does one thing: invoke the holder, and invoke the next one when the
 *   current one hands over. Because it never ends between two holders, an
 *   arrival cannot start a second, empty thread while state is moving from one
 *   holder to the next.
 * - **The holder** (`<agent>-thread-run`) is long-lived and holds everything:
 *   every subscription, the log, and the state. It has **no event triggers and
 *   no singleton** - only `invoke()` - so a successor can never be skipped by
 *   its predecessor, and no event anybody sends can start one.
 *
 * That split is the design decision, and it is the shape the thread ledger
 * used before this replaced it. It makes two model-checked holes
 * unreachable rather than defended: an arrival cannot spawn a holder of its
 * own, so it cannot duplicate a write into the log, and no single arrival can
 * drive a series of holders.
 *
 * The holder is the only writer to its thread's state, it answers reads **on
 * receipt**, it applies writes idempotently by their id, and it forwards what
 * arrives to the agent as one event per batch. **Forwards are advisory and the
 * log is authoritative**, so a forward lost at the agent's singleton costs
 * latency rather than data.
 *
 * KNOWN LIMITS, both real and neither hidden:
 *
 * - **The supervisor's own ceiling.** It spends one step per generation, so a
 *   thread gets roughly as many generations as a run gets steps - about 900 -
 *   and then the supervisor itself has nowhere to go and the thread is lost.
 *   The ledger has the same limit and does not say so, which is how it stayed
 *   invisible; it is said here.
 * - **The handover gap.** A holder stops reading, returns, and its successor
 *   subscribes a request later. An arrival in that window reaches nothing: the
 *   supervisor is live, so its trigger is skipped, and no subscription is
 *   open. Same class as the accepted gap where a write to a thread with no
 *   live run reaches nothing and nobody is told, and bounded by one request
 *   rather than by anything a user does.
 *
 * See `threadProtocol.ts` for the events, the state that travels on them, and
 * the gaps this design accepts rather than engineers away.
 */

import { stepsIssued } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import {
  type InngestFunction,
  internalQuietOptimizeParallelism,
} from "../../../components/InngestFunction.ts";
import {
  type Inbox,
  inboxOpenedPromise,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import { InboxMiddleware } from "../../../components/inbox/middleware.ts";
import { invoke, staticSchema } from "../../../components/triggers/triggers.ts";
import { startData } from "../agent/startEvent.ts";
import type {
  AgentFunctionConfig,
  InboxSource,
  StepWithSubscribe,
} from "../agent/types.ts";
import {
  eventNameOf,
  inboxFilter,
  missingThreadFilter,
  ownEvents,
  ownInboxFilter,
  ownTriggerFilter,
  quote,
} from "../inbox/threadInbox.ts";
import {
  applyThreadWriteEvent,
  emptySnapshot,
  forwardStateLimit,
  isThreadControl,
  rememberedWrites,
  reservedListenEvent,
  sameListen,
  startReadSignal,
  type ThreadEntry,
  type ThreadListenData,
  type ThreadReadData,
  type ThreadSnapshot,
  type ThreadWriteData,
  threadDone,
  threadForward,
  threadListen,
  threadLost,
  threadRead,
  threadSubscriptionFilter,
  threadTriggerFilter,
  threadWrite,
} from "./threadProtocol.ts";
import { type CompiledTrigger, singletonKey } from "./threadTrigger.ts";

/**
 * How many steps a holder spends before it hands over. Each read of its
 * subscription is a step and each forward is another, so a busy thread hands
 * over every few hundred arrivals.
 */
const handoverAt = 700;

/**
 * How long a thread lives with nothing arriving: the longest a holder waits
 * for its next batch. A read that comes back empty ends the thread, exactly as
 * an `agent/thread.done` does, so its state is gone and the next arrival
 * starts an empty one.
 *
 * Everything the holder subscribes to counts as arriving, a read and a write
 * included. A thread waiting on a listen or an inbox source is still idle, and
 * ends with the rest: 12 hours is the most a thread can wait for anything, for
 * now. It is a ceiling to raise once state outlives the run that holds it, and
 * it exists because a thread that never ends leaves two runs live for ever.
 */
const readTimeout = "12h";

/**
 * How many holders may fail for good, in a row, before the supervisor gives up
 * on the thread. Each failure emits a give-up of its own and starts the next
 * generation from nothing.
 */
const holderFailures = 3;

/**
 * How long the supervisor waits on a holder: a thread lives as long as the
 * platform lets a run live.
 */
const holdTimeout = "365d";

/**
 * What the supervisor invokes a holder with: the thread, which generation it
 * is, and either the arrival that started the thread or the state the last
 * generation handed over.
 */
interface HolderInput extends Record<string, unknown> {
  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string;
  thread: string;
  generation: number;

  /**
   * The event that started the thread, for the first generation only.
   */
  start?: { id?: string; name: string; data?: unknown; ts?: number };

  /**
   * What the last generation held. It travels as the invoke's return value and
   * then as this input, rather than on an event, so nothing about it can be
   * skipped, dropped, or rejected for its size.
   */
  carried?: ThreadSnapshot;

  /**
   * The listens the last generation recorded and has not acknowledged. This
   * generation acknowledges them once it has subscribed.
   */
  owed?: ListenAck[];
}

/**
 * The acknowledgement of one listen: the signal the agent run waits on, and
 * what it is told.
 */
interface ListenAck {
  signal: string;
  data: { listening: boolean; event: string };
}

/**
 * What a holder gives back: the state to hand to its successor, or nothing
 * when the thread is over.
 */
interface HolderResult {
  thread: string;
  generation: number;
  ended: "done" | "handover" | "lost";
  entries: number;

  /**
   * The state the next generation starts from. Absent: the thread is over and
   * its state is meant to be gone.
   */
  handover?: ThreadSnapshot;

  /**
   * The listens this generation recorded and left for the next to
   * acknowledge.
   */
  owed?: ListenAck[];
}

/**
 * The holder's view of one arrival: a log entry.
 */
const entryOf = (
  message: { id?: string; name: string; data?: unknown; ts?: number },
  seq: number,
): ThreadEntry => {
  return {
    seq,
    ...(message.id !== undefined && { id: message.id }),
    name: message.name,
    data: message.data,
    ts: message.ts ?? 0,
  };
};

/**
 * What one batch did, which is what decides whether the holder carries on.
 */
interface Applied {
  /**
   * The entries this batch appended, in order: what the forward carries.
   */
  appended: ThreadEntry[];

  /**
   * A deliberate ending arrived.
   */
  done?: true;

  /**
   * A listen was recorded, so the subscription has to be made again, which is
   * a handover.
   */
  listened?: true;

  /**
   * The listens this batch recorded, each still to be acknowledged.
   */
  acks: ListenAck[];
}

/**
 * What the thread functions of one agent need.
 */
export interface ThreadRunDeps {
  client: Inngest.Any;
  config: AgentFunctionConfig;

  /**
   * The agent, as `"appId/functionId"`.
   */
  ref: string;
  triggers: CompiledTrigger[];

  /**
   * The agent's `inbox` sources, each already placed by a thread expression.
   */
  inboxSources: InboxSource[];
}

/**
 * EXPERIMENTAL: makes the two thread functions of one agent: the supervisor
 * that keeps the thread's key, and the holder that holds its state.
 */
export function createThreadFunctions(deps: ThreadRunDeps): {
  supervisor: InngestFunction.Any;
  holder: InngestFunction.Any;
} {
  const { client, config, ref, triggers, inboxSources } = deps;

  const holder = client.createFunction(
    {
      id: `${config.id}-thread-run`,
      name: `${config.id} thread`,

      // No event triggers and no singleton, on purpose. The supervisor is the
      // only thing that starts one, so a successor cannot be skipped by its
      // predecessor and no event anybody sends can start a holder of its own.
      triggers: [invoke(staticSchema<HolderInput>())],
      middleware: [InboxMiddleware, ...(config.middleware ?? [])],

      // The holder reads its subscription beside its work, and a read left
      // waiting never holds the run back.
      optimizeParallelism: false,
      ...({
        [internalQuietOptimizeParallelism]: true,
      } as object),
    },
    async (ctx) => {
      const { logger } = ctx;
      const step = ctx.step as unknown as StepWithSubscribe;
      const input = ctx.event.data as unknown as HolderInput;
      const thread = input.thread;
      const generation = input.generation;

      // Subscribed before anything else this run does. An arrival that lands
      // before this matches nothing, because the primitive is forward-only.
      await using subscription = step.subscribe("thread", [
        // The agent layer's own events, for this thread.
        ...ownEvents.map((name) => {
          return { event: name, if: ownInboxFilter(name, ref, thread) };
        }),

        // The agent's triggers, for this thread.
        ...triggers
          .filter((trigger) => {
            return trigger.listen;
          })
          .map((trigger) => {
            const own = `(${trigger.thread.asAsync}) == ${quote(thread)}`;

            return {
              event: trigger.event,
              if: trigger.asyncIf ? `(${trigger.asyncIf}) && ${own}` : own,
            };
          }),

        // Every configured inbox source.
        ...inboxSources.flatMap((source) => {
          const missing = missingThreadFilter(source, config.thread);

          return [
            {
              event: eventNameOf(source.event),
              if: inboxFilter(source, thread, config.thread),
            },
            ...(missing === undefined
              ? []
              : [{ event: eventNameOf(source.event), if: missing }]),
          ];
        }),

        // Every listen an agent asked for, re-established: the primitive is
        // forward-only, so a new generation has to subscribe again.
        ...(input.carried?.listens ?? [])
          .filter((listen) => {
            return !reservedListenEvent(listen.event);
          })
          .map((listen) => {
            return {
              event: listen.event,
              ...(listen.if !== undefined && { if: listen.if }),
            };
          }),

        // The protocol's own, for this thread.
        ...[threadRead, threadWrite, threadListen, threadDone].map((type) => {
          return {
            event: type.name,
            if: threadSubscriptionFilter(ref, thread),
          };
        }),
      ]);

      await inboxOpenedPromise(subscription);

      // Note on `threadInbox`'s `drainSource`, which skips a drain when no step
      // has been issued since the last read: the holder never drains. Every
      // read here is a bounded `nextBatch`, which is a step of its own, so the
      // count always moves and the skip is not on this path. The obvious
      // optimisation - drain first to avoid paying for a wait - would walk
      // straight into it.

      const inbox = subscription as unknown as Inbox<UntypedInboxMessage>;
      const state: ThreadSnapshot = input.carried
        ? { ...input.carried, gen: generation }
        : emptySnapshot();

      // Applying an arrival is idempotent: an event the log already holds by
      // ID is not appended again. The same event can reach the holder twice -
      // through its own subscription, and handed over by an agent run with its
      // read - and the log is what every read and every handover is built from.
      const logged = new Set<string>(
        state.entries.flatMap((entry) => {
          return entry.id ? [entry.id] : [];
        }),
      );
      const append = (message: {
        id?: string;
        name: string;
        data?: unknown;
        ts?: number;
      }): ThreadEntry | undefined => {
        if (message.id !== undefined && message.id !== "") {
          if (logged.has(message.id)) {
            return undefined;
          }

          logged.add(message.id);
        }

        state.seq += 1;

        const entry = entryOf(message, state.seq);

        state.entries.push(entry);

        return entry;
      };

      // Counts of each kind of step this body issues. Each is a pure function
      // of what the run has durably done, so a replay derives the same IDs: a
      // module-level counter would not.
      let forwards = 0;
      let answers = 0;
      let acks = 0;
      let warnedSize = false;

      /**
       * Sends what arrived to the agent. Advisory: if it is lost at the
       * agent's singleton the agent is late, not wrong, because the log still
       * holds it and the next read hands it back.
       */
      const forward = async (appended: ThreadEntry[]) => {
        if (appended.length === 0) {
          return;
        }

        const nth = forwards++;

        // The state travels with the forward when it is small enough, so a run
        // this forward starts needs no read at all. A run that is already live
        // ignores it. Sent optimistically, because the agent's singleton
        // decides which of the two happens after this event is gone.
        const carried = JSON.stringify(state);
        const small = carried.length <= forwardStateLimit;

        if (!small && !warnedSize) {
          warnedSize = true;
          logger.debug(
            { thread, size: carried.length },
            "thread state is too big to travel on a forward, so agent runs will read it instead",
          );
        }

        await step.sendEvent(
          `forward:${nth}`,
          threadForward.create(
            {
              agent: ref,
              thread,
              gen: generation,
              events: appended,
              ...(small && { state: JSON.parse(carried) as ThreadSnapshot }),
            },
            // The run a forward starts is in the thread's sessions, as a run
            // an `agent/message` started was.
            {
              meta: {
                sessions: { agent_session: thread, agent_thread: thread },
              },
            },
          ),
        );
      };

      /**
       * Answers one read. Computed here, on receipt, and never served from a
       * cache: a precomputed answer reopens the gap that issuing the wait and
       * the send together closes.
       */
      const answerRead = async (request: ThreadReadData) => {
        const nth = answers++;

        await step.sendSignal(`read:${nth}`, {
          signal: request.signal,
          data: state,
        });
      };

      /**
       * Takes one batch in: appends arrivals, answers reads, applies writes,
       * records listens. The one place state changes.
       */
      const applyBatch = async (
        batch: UntypedInboxMessage[],
      ): Promise<Applied> => {
        const applied: Applied = { appended: [], acks: [] };

        for (const message of batch) {
          if (!isThreadControl(message.name)) {
            const entry = append(message);

            if (entry) {
              applied.appended.push(entry);
            }

            continue;
          }

          switch (message.name) {
            case threadRead.name: {
              const request = message.data as ThreadReadData;

              // An agent hands over the event that started it, so the log
              // holds it even when the holder never saw it (a typed `invoke()`
              // start). It is never forwarded: the agent has it.
              if (request.arrival) {
                const entry = append(request.arrival);

                if (entry) {
                  state.taken = Math.max(state.taken, entry.seq);
                }
              }

              await answerRead(request);

              break;
            }
            case threadWrite.name: {
              // The log is keyed on the write's id. A write can reach the
              // holder twice - a step's retry sends it again - and applying it
              // twice would put the same change in the log twice.
              applyThreadWriteEvent(state, message.data as ThreadWriteData);

              break;
            }
            case threadListen.name: {
              const asked = message.data as ThreadListenData;

              // What the asker had read when it asked. Its own confirmation
              // may be about to land where nothing is subscribed.
              if (asked.taken !== undefined) {
                state.taken = Math.max(state.taken, asked.taken);
              }
              const held = state.listens.find((listen) => {
                return sameListen(listen, asked.listen);
              });
              const others = state.listens.filter((listen) => {
                return !sameListen(listen, asked.listen);
              });

              // the agent run checks the name before it asks.  this check is
              // for a listen event that something else sent.
              const refused =
                !asked.remove && reservedListenEvent(asked.listen.event);

              if (refused) {
                logger.warn(
                  {
                    agent: ref,
                    thread,
                    event: asked.listen.event,
                  },
                  "thread refused to watch a reserved event name",
                );
              } else if (asked.remove) {
                if (held) {
                  state.listens = others;
                  applied.listened = true;
                }
              } else if (!held || held.if !== asked.listen.if) {
                // the same request with a new scope replaces the old one.
                state.listens = [...others, asked.listen];
                applied.listened = true;
              }

              if (asked.signal) {
                applied.acks.push({
                  signal: asked.signal,
                  data: {
                    listening: !asked.remove && !refused,
                    event: asked.listen.event,
                  },
                });
              }

              break;
            }
            case threadDone.name:
              applied.done = true;

              break;
            default:
              break;
          }
        }

        return applied;
      };

      const acknowledge = async (owed: ListenAck[]) => {
        for (const ack of owed) {
          const nth = acks++;

          await step.sendSignal(`listen:${nth}`, ack);
        }
      };

      const over = (
        ended: HolderResult["ended"],
        handover?: ThreadSnapshot,
        owed: ListenAck[] = [],
      ): HolderResult => {
        return {
          thread,
          generation,
          ended,
          entries: state.seq,
          ...(handover && { handover }),
          ...(owed.length > 0 && { owed }),
        };
      };

      /**
       * Ends this generation if the batch asks for it, and acknowledges the
       * batch's listens when it does not.
       *
       * A listen that changes what the thread subscribes to makes this run
       * hand over, and between this run ending and the next one subscribing
       * nothing is subscribed. An agent run told "recorded" at this point
       * carries on, and what it sends next - a write, usually - lands in that
       * gap and reaches nothing. So those listens are acknowledged by the next
       * generation, after it has subscribed.
       */
      const settle = async (
        applied: Applied,
      ): Promise<HolderResult | undefined> => {
        if (applied.done) {
          await acknowledge(applied.acks);

          return over("done");
        }

        if (applied.listened) {
          // A new listen only takes effect in a new subscription, and a
          // handover is how a subscription is made again. One mechanism rather
          // than two.
          return over("handover", state, applied.acks);
        }

        await acknowledge(applied.acks);

        return undefined;
      };

      // What the last generation left to acknowledge, now that this one is
      // subscribed.
      await acknowledge(input.owed ?? []);

      // The first generation takes the arrival that started the thread as its
      // first entry and forwards it, which is what wakes the agent.
      if (input.start) {
        const first = await applyBatch([
          {
            id: input.start.id ?? "",
            name: input.start.name,
            data: input.start.data,
            ts: input.start.ts ?? 0,
          } as unknown as UntypedInboxMessage,
        ]);

        // A cron tick or an invoke starts an agent run of its own as well as
        // this thread, and that run asks for the thread's state at about the
        // moment this run subscribes. A read that lands before the
        // subscription reaches nothing, so the state is sent to that run
        // unasked, on the signal it waits on. Nothing else needs it: every
        // other start reaches the agent as the forward below, which carries
        // the state.
        const startsAgent = triggers.some((trigger) => {
          return trigger.event === input.start?.name && !trigger.listen;
        });

        if (
          startsAgent &&
          input.start.id !== undefined &&
          input.start.id !== ""
        ) {
          await step.sendSignal("start:state", {
            signal: startReadSignal(ref, thread, input.start.id),
            data: state,
          });
        }

        await forward(first.appended);

        const ended = await settle(first);

        if (ended) {
          return ended;
        }
      }

      // A read kept armed while the holder works. `nextBatch` is called before
      // the batch in hand is applied and forwarded, and awaited at the top of
      // the next turn of the loop, so an arrival that lands while the holder is
      // busy is already being read for rather than falling into the gap between
      // two reads. It is the same thing the default agent body's background
      // reader does, and the measured difference between a body that has one
      // and a body that does not.
      //
      // Deliberately NOT a race. A memoized step's result has to be the same on
      // a replay, and `Promise.race` is the opposite of that; this arms a read
      // and awaits it in a fixed order, which replays identically. The bounded
      // timeout below is what provides liveness, not a timer beside the read.
      let armed: Promise<UntypedInboxMessage[] | null | undefined> | undefined;
      const arm = () => {
        armed ??= inbox.nextBatch({ timeout: readTimeout });

        return armed;
      };

      for (;;) {
        if ((stepsIssued() ?? 0) >= handoverAt) {
          return over("handover", state);
        }

        const batch = await arm();

        armed = undefined;

        if (batch === undefined) {
          // The inbox closed, which only this run does.
          return over("done");
        }

        if (batch === null) {
          // Nothing arrived for as long as a thread may sit idle, so it ends.
          return over("done");
        }

        // The next read is armed before this batch is applied, so the window
        // in which the holder is busy is covered rather than open.
        arm();

        // Applying what arrived and deciding to end are one path, not two: the
        // state a handover carries is what this batch applied, and nothing
        // happens between the two.
        const applied = await applyBatch(batch);

        await forward(applied.appended);

        const ended = await settle(applied);

        if (ended) {
          return ended;
        }
      }
    },
  );

  const supervisor = client.createFunction(
    {
      id: `${config.id}-thread`,
      name: `${config.id} thread supervisor`,

      // One live supervisor per thread, keyed on the thread alone - the only
      // thing an arriving event can be keyed on, because the key is evaluated
      // before any code runs. It never ends between two holders, so an arrival
      // cannot start a second, empty thread while state is moving.
      singleton: { key: singletonKey(triggers), mode: "skip" },
      triggers: [
        // An agent-layer event with no live thread starts one.
        ...ownEvents.map((name) => {
          return { event: name, if: ownTriggerFilter(name, ref) };
        }),

        // Everything the agent declares as a trigger reaches the thread first.
        ...triggers.map((trigger) => {
          return trigger.fnTrigger;
        }),

        // The protocol's own. A read, a write or a listen for a thread with no
        // live run starts one, which is what makes the first message of a
        // conversation work.
        ...[threadRead, threadWrite, threadListen, threadDone].map((type) => {
          return { event: type.name, if: threadTriggerFilter(ref) };
        }),
      ],
    },
    async (ctx) => {
      const { event, step, logger } = ctx;
      const found = triggers.find((trigger) => {
        return trigger.event === event.name;
      });
      const start = startData(ref, found, event);
      const thread = start.thread;

      let input: HolderInput = {
        agent: ref,
        thread,
        generation: 1,
        start: {
          ...(event.id !== undefined && { id: event.id }),
          name: event.name,
          data: event.data,
          ts: event.ts ?? 0,
        },
      };

      // One step per generation. A run has roughly 900 steps, so a thread has
      // roughly 900 generations and then the supervisor has nowhere to go and
      // the thread is lost: a known limit, accepted, and stated here because
      // nothing else will say it.
      // Holders that failed for good, in a row. A thread is worth restarting
      // from nothing - it says it is empty rather than looking like one whose
      // history was lost - but not for ever: a holder that fails on the way up
      // would otherwise be invoked again as fast as the platform allows.
      let failures = 0;

      for (let generation = 1; ; generation += 1) {
        let result: HolderResult | null;

        try {
          result = (await step.invoke(`hold:${generation}`, {
            function: holder,
            data: input,
            timeout: holdTimeout,
          })) as HolderResult | null;
          failures = 0;
        } catch (error) {
          failures += 1;

          // A give-up says so on an event of its OWN, never on the done path:
          // a deliberate ending means the state is meant to be gone, and
          // anything that borrows it hides a loss behind an ending that the
          // loss checks exempt.
          await step.sendEvent(
            `lost:${generation}`,
            threadLost.create({
              agent: ref,
              thread,
              generation,
              why: error instanceof Error ? error.message : String(error),
            }),
          );

          if (failures >= holderFailures) {
            return { thread, generation, ended: "lost", entries: 0 };
          }

          // Start again from nothing. The log since the last handover is gone,
          // which is the accepted gap for a thread run that fails for good,
          // and the next generation says that it is empty.
          input = { agent: ref, thread, generation: generation + 1 };

          continue;
        }

        if (!result?.handover) {
          return result;
        }

        if (generation % 100 === 0) {
          logger.debug(
            { thread, generation },
            "this thread has handed over many times; a supervisor runs out of steps at roughly 900",
          );
        }

        input = {
          agent: ref,
          thread,
          generation: generation + 1,
          carried: result.handover,
          ...(result.owed && { owed: result.owed }),
        };
      }
    },
  );

  return {
    supervisor: supervisor as unknown as InngestFunction.Any,
    holder: holder as unknown as InngestFunction.Any,
  };
}
