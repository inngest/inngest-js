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
 * That split is the design decision, and it is the shape the existing thread
 * ledger already uses (`threads/ledger.ts`). It makes two model-checked holes
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
  applyThreadWrite,
  emptySnapshot,
  forwardStateLimit,
  isThreadControl,
  rememberedWrites,
  type ThreadEntry,
  type ThreadListen,
  type ThreadListenData,
  type ThreadReadData,
  type ThreadSnapshot,
  type ThreadWriteData,
  threadAgentFilter,
  threadDone,
  threadFilter,
  threadForward,
  threadListen,
  threadRead,
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
 * How long a holder waits for its next batch before the read comes back empty.
 * Every empty read costs a step, so this is what an idle thread spends: one
 * step a minute.
 */
const readTimeout = "1m";

/**
 * What a holder of a thread nobody is asking after waits instead. Reached
 * after `quietGenerations` generations in a row with nothing delivered.
 */
const dormantTimeout = "15m";

/**
 * How many generations of nothing it takes before a holder backs off to
 * `dormantTimeout`.
 */
const quietGenerations = 2;

/**
 * How many empty reads in a row make a holder hand over.
 *
 * THIS IS NOT WEDGE DETECTION, and calling it that would invite a check that
 * cannot be written. N empty reads in a row is indistinguishable from a
 * conversation nobody is talking in: there is no way to tell "this
 * subscription stopped delivering" from "nothing has happened". So what this
 * does is **recycle the holder periodically**, and a subscription that had
 * stopped delivering is fixed as a side effect, because the successor
 * subscribes again.
 *
 * It is also the whole of the recovery latency for that case. A holder that
 * waited for its step ceiling instead would take `handoverAt` reads to recycle,
 * which at this timeout is most of a day; recycling after a few makes it
 * `empties x timeout`, which is minutes, and tunable.
 *
 * **A handover restores the thread. It does not recover the messages**: what
 * was lost while the subscription was not delivering is gone, and the
 * successor starts after the loss.
 */
const handoverAfterEmpties = 5;

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
   * How many generations in a row have ended with nothing delivered.
   *
   * A thread that is being used reads with a short timeout, so a subscription
   * that stopped delivering is noticed in minutes. One nobody is asking after
   * backs off, so a dormant thread costs a couple of steps an hour rather than
   * one a minute. Every timed read costs exactly one step whether or not
   * anything arrives, which is what makes this a real trade rather than a
   * tuning detail.
   */
  quiet?: number;
}

/**
 * What a holder gives back: the state to hand to its successor, or nothing
 * when the thread is over.
 */
interface HolderResult {
  thread: string;
  generation: number;
  ended: "done" | "handover";
  entries: number;

  /**
   * How many generations in a row have now ended with nothing delivered, which
   * the next one reads with.
   */
  quiet?: number;

  /**
   * The state the next generation starts from. Absent: the thread is over and
   * its state is meant to be gone.
   */
  handover?: ThreadSnapshot;
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
        ...(input.carried?.listens ?? []).map((listen) => {
          return {
            event: listen.event,
            ...(listen.if !== undefined && { if: listen.if }),
          };
        }),

        // The protocol's own, for this thread.
        ...[threadRead, threadWrite, threadListen, threadDone].map((type) => {
          return { event: type.name, if: threadFilter(ref, thread) };
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
          threadForward.create({
            agent: ref,
            thread,
            gen: generation,
            events: appended,
            ...(small && { state: JSON.parse(carried) as ThreadSnapshot }),
          }),
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
        const applied: Applied = { appended: [] };

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
              const write = message.data as ThreadWriteData;

              state.writes ??= [];

              const seen = state.writes;

              // The log is keyed on the write's id. A write can reach the
              // holder twice - a step's retry sends it again - and applying it
              // twice would put the same change in the log twice.
              if (write.id !== undefined && seen.includes(write.id)) {
                break;
              }

              for (const op of write.ops ?? []) {
                applyThreadWrite(state, op);
              }

              if (write.id !== undefined) {
                seen.push(write.id);

                if (seen.length > rememberedWrites) {
                  seen.splice(0, seen.length - rememberedWrites);
                }
              }

              break;
            }
            case threadListen.name: {
              const asked = message.data as ThreadListenData;
              const same = (listen: ThreadListen) => {
                return (
                  listen.event === asked.listen.event &&
                  listen.if === asked.listen.if
                );
              };
              const already = state.listens.some(same);

              if (asked.remove) {
                if (already) {
                  state.listens = state.listens.filter((listen) => {
                    return !same(listen);
                  });
                  applied.listened = true;
                }
              } else if (!already) {
                state.listens.push(asked.listen);
                applied.listened = true;
              }

              if (asked.signal) {
                const nth = acks++;

                await step.sendSignal(`listen:${nth}`, {
                  signal: asked.signal,
                  data: { listening: !asked.remove, event: asked.listen.event },
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

      // Nothing has been delivered to this generation yet.
      let quiet = true;
      const over = (
        ended: HolderResult["ended"],
        handover?: ThreadSnapshot,
      ): HolderResult => {
        return {
          thread,
          generation,
          ended,
          entries: state.seq,
          quiet: quiet ? (input.quiet ?? 0) + 1 : 0,
          ...(handover && { handover }),
        };
      };

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

        quiet = false;
        await forward(first.appended);

        if (first.done) {
          return over("done");
        }

        if (first.listened) {
          return over("handover", state);
        }
      }

      // Reads that came back empty in a row.
      let empties = 0;

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
        armed ??= inbox.nextBatch({
          timeout:
            (input.quiet ?? 0) >= quietGenerations
              ? dormantTimeout
              : readTimeout,
        });

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
          empties += 1;

          if (empties >= handoverAfterEmpties) {
            // Alive, but nothing has been delivered for a while. Hand over
            // rather than wait for the step ceiling: a successor subscribes
            // again, which is the only thing that recovers a subscription that
            // stopped delivering. What was lost meanwhile stays lost.
            return over("handover", state);
          }

          continue;
        }

        empties = 0;
        quiet = false;

        // The next read is armed before this batch is applied, so the window
        // in which the holder is busy is covered rather than open.
        arm();

        // Applying what arrived and deciding to end are one path, not two: the
        // state a handover carries is what this batch applied, and nothing
        // happens between the two.
        const applied = await applyBatch(batch);

        await forward(applied.appended);

        if (applied.done) {
          return over("done");
        }

        if (applied.listened) {
          // A new listen only takes effect in a new subscription, and a
          // handover is how a subscription is made again. One mechanism rather
          // than two.
          return over("handover", state);
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
          return { event: type.name, if: threadAgentFilter(ref) };
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
      for (let generation = 1; ; generation += 1) {
        const result = (await step.invoke(`hold:${generation}`, {
          function: holder,
          data: input,
          timeout: holdTimeout,
        })) as HolderResult | null;

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
          ...(result.quiet !== undefined && { quiet: result.quiet }),
        };
      }
    },
  );

  return {
    supervisor: supervisor as unknown as InngestFunction.Any,
    holder: holder as unknown as InngestFunction.Any,
  };
}
