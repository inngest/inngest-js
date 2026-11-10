/**
 * @module
 * EXPERIMENTAL: the thread run. One Inngest function per agent definition,
 * keyed by the same thread expression the agent declares.
 *
 * It is the **only writer** to its thread's state, it holds **every**
 * subscription, and it holds the thread's log. Agent runs are short-lived and
 * many; this is the one long-lived thing in a conversation.
 *
 * What it does, in one place so the whole of it can be read at once:
 *
 * - subscribes to the agent-layer events of its thread, every configured
 *   `inbox` source, and every listen an agent asked for at runtime
 *   (re-established here after a rollover, because `step.subscribe()` is
 *   forward-only);
 * - appends each arrival to its log and forwards the batch to the agent as one
 *   event, which is a trigger on the agent function under a per-thread
 *   singleton in `skip` mode;
 * - answers an agent run's read **on receipt**, never from a cache, because a
 *   precomputed answer reopens the gap that issuing the wait and the send
 *   together closes;
 * - applies writes, which arrive fire and forget;
 * - records listens and acknowledges them, so the model's tool can say the
 *   subscription is in place;
 * - rolls over before it runs out of steps, handing its whole state to a
 *   successor on one event;
 * - ends on an explicit done, and emits a **distinct** event when it gives up.
 *
 * See `threadProtocol.ts` for the events, the state that travels on them, and
 * the gaps this design accepts rather than engineers away.
 */

import { stepsIssued } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { internalQuietOptimizeParallelism } from "../../../components/InngestFunction.ts";
import {
  type Inbox,
  inboxOpenedPromise,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import { InboxMiddleware } from "../../../components/inbox/middleware.ts";
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
  generationKey,
  handoverSignal,
  isThreadControl,
  rememberedWrites,
  type ThreadEntry,
  type ThreadListen,
  type ThreadListenData,
  type ThreadReadData,
  type ThreadReadyData,
  type ThreadResumeData,
  type ThreadSnapshot,
  type ThreadWriteData,
  type ThreadWriteOp,
  threadAgentFilter,
  threadDone,
  threadFilter,
  threadForward,
  threadHello,
  threadListen,
  threadLive,
  threadLost,
  threadRead,
  threadReady,
  threadResume,
  threadWrite,
} from "./threadProtocol.ts";
import { type CompiledTrigger, singletonKey } from "./threadTrigger.ts";

/**
 * How many steps a thread run spends before it hands over. Well under any
 * per-run step ceiling, because the handover itself costs a few and the drain
 * that follows costs more.
 */
const rolloverSteps = 400;

/**
 * How long a successor waits for the final state before it announces itself
 * again. **Rule 6**: retry on timeout, never end - ending orphans the thread.
 */
const handoverTimeout = "2m";

/**
 * How many times a successor re-announces before it gives up. A give-up emits
 * its own event (**rule 7**), never the done path.
 */
const handoverAttempts = 5;

/**
 * How long a thread run that may not be alone waits before it answers its
 * first read, so a holder that already has the thread's history answers first.
 * Paid once, by the first read of a generation that started cold.
 */
const soloGrace = 2_000;

/**
 * The thread run's view of one arrival: a log entry, or nothing when the
 * message is one of the protocol's own.
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
 * What one batch did, which is what decides whether the run carries on.
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
   * A successor announced itself.
   */
  ready?: ThreadReadyData;

  /**
   * Another holder answered this run's hello, so this run stands down.
   */
  standDown?: true;

  /**
   * A listen was recorded, so the subscription has to be re-established.
   */
  listened?: true;
}

/**
 * The options and the state one thread run needs; separated so the body reads
 * as the protocol rather than as plumbing.
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
 * EXPERIMENTAL: makes the thread run of one agent.
 */
export function createThreadFunction(deps: ThreadRunDeps): InngestFunction.Any {
  const { client, config, ref, triggers, inboxSources } = deps;
  const logName = `${config.id} thread`;

  return client.createFunction(
    {
      id: `${config.id}-thread`,
      name: logName,
      middleware: [InboxMiddleware, ...(config.middleware ?? [])],

      // The thread reads its subscription beside its work, and a read left
      // waiting never holds the run back.
      optimizeParallelism: false,
      ...({
        [internalQuietOptimizeParallelism]: true,
      } as object),

      // One run per thread, per generation. The generation is in the key so a
      // live predecessor does not block its successor; everything else keys to
      // the thread, so an arrival reaches the holder rather than starting a
      // second one. A gen-0 run that starts anyway, because a later
      // generation holds the thread under another key, stands down as soon as
      // the holder answers its hello.
      singleton: {
        key: `event.name == ${quote(threadResume.name)} ? event.data.gen : (${singletonKey(triggers)})`,
        mode: "skip",
      },
      triggers: [
        // An agent-layer event with no live thread starts one.
        ...ownEvents.map((name) => {
          return { event: name, if: ownTriggerFilter(name, ref) };
        }),

        // Everything the agent declares as a trigger is an arrival here: the
        // thread sees it first and forwards it on.
        ...triggers.map((trigger) => {
          return trigger.fnTrigger;
        }),

        // The protocol's own. A read, a write or a listen for a thread with no
        // live run starts one, which is what makes the first message of a
        // conversation work.
        ...[threadRead, threadWrite, threadListen, threadDone].map((type) => {
          return { event: type.name, if: threadAgentFilter(ref) };
        }),
        { event: threadResume.name, if: threadAgentFilter(ref) },
      ],
    },
    async (ctx) => {
      const { event, logger } = ctx;
      const step = ctx.step as unknown as StepWithSubscribe;
      const resume =
        event.name === threadResume.name
          ? (event.data as ThreadResumeData)
          : undefined;
      const found = triggers.find((trigger) => {
        return trigger.event === event.name;
      });
      const start = startData(ref, found, event);
      const thread = resume ? resume.thread : start.thread;
      const generation = resume ? resume.generation : 0;
      const gen = generationKey(thread, generation);

      // **Rule 5**: subscribe early. The subscription is opened before
      // anything else, including the announcement, because an arrival that
      // lands before it matches nothing: the primitive is forward-only.
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

        // Every listen an agent asked for, re-established.
        ...(resume?.state.listens ?? []).map((listen) => {
          return {
            event: listen.event,
            ...(listen.if !== undefined && { if: listen.if }),
          };
        }),

        // The protocol's own.
        ...[
          threadRead,
          threadWrite,
          threadListen,
          threadDone,
          threadReady,
          threadHello,
          threadLive,
        ].map((type) => {
          return { event: type.name, if: threadFilter(ref, thread) };
        }),
      ]);

      await inboxOpenedPromise(subscription);

      const inbox = subscription as unknown as Inbox<UntypedInboxMessage>;
      let state: ThreadSnapshot = resume
        ? { ...resume.state, gen: generation }
        : emptySnapshot();

      // Applying an arrival is idempotent: an event the log already holds by
      // ID is not appended again. The same event can reach the thread twice -
      // through its own subscription, and handed over by an agent run with its
      // read - and the log is what every later read and rollover is built
      // from.
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

      // Whether this run might not be alone: a generation that started from an
      // arrival rather than a handover cannot know whether a later generation
      // holds the thread under another singleton key. It holds from the off
      // anyway - **rule 5** is about a handover, and waiting here would put a
      // timeout on the first message of every conversation - but it lets a
      // holder answer a read first.
      let unconfirmed = resume === undefined;
      let graced = false;

      // The predecessor's handover, once this run has asked for a successor.
      let handing: { signal: string; generation: number } | undefined;

      // Counts of each kind of step this body issues. Each is a pure function
      // of what the run has durably done, so a replay derives the same IDs: a
      // module-level counter would not.
      let forwards = 0;
      let warnedSize = false;
      let answers = 0;
      let acks = 0;

      /**
       * Sends what arrived to the agent. Advisory: if it is lost at the skip
       * boundary the agent is late, not wrong, because the log still holds it
       * and the next read hands it back.
       */
      const forward = async (appended: ThreadEntry[]) => {
        if (appended.length === 0) {
          return;
        }

        const nth = forwards++;

        // The state travels with the forward when it is small enough, so a run
        // this forward starts needs no read at all. A run that is already live
        // ignores it. Sent optimistically, because the singleton decides which
        // of the two happens after this event is gone.
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
        // A run that may not be alone gives a holder with the thread's history
        // the chance to answer first. Once, and only before the first answer.
        if (unconfirmed && !graced) {
          graced = true;
          await step.sleep("solo-grace", soloGrace);

          const late = await inbox.drain();

          if (late.length > 0) {
            await applyBatch(late);
          }
        }

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
      async function applyBatch(
        batch: UntypedInboxMessage[],
      ): Promise<Applied> {
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
              // holds it even when the thread never saw it (a typed
              // `invoke()` start). The thread is subscribed to most of what
              // starts an agent, so an arrival it already holds is dropped by
              // its ID rather than logged twice. It is never forwarded: the
              // agent has it.
              if (request.arrival) {
                const entry = append(request.arrival);

                // The agent has it already, so nothing is forwarded and the
                // log counts it as taken up.
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

              const applied = state.writes;

              // The log is keyed on the write's id. A write can reach the
              // thread twice - a step's retry sends it again, and a holder
              // standing down re-sends what it took - and applying it twice
              // would put the same change in the log twice.
              if (write.id !== undefined && applied.includes(write.id)) {
                break;
              }

              for (const op of write.ops ?? []) {
                applyThreadWrite(state, op);
              }

              if (write.id !== undefined) {
                applied.push(write.id);

                if (applied.length > rememberedWrites) {
                  applied.splice(0, applied.length - rememberedWrites);
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
                  data: { listening: true, event: asked.listen.event },
                });
              }

              break;
            }
            case threadDone.name:
              applied.done = true;

              break;
            case threadReady.name:
              applied.ready = message.data as ThreadReadyData;

              break;
            case threadHello.name: {
              const hello = message.data as { generation?: number };

              // A younger run asking whether anyone holds the thread. Answer
              // it: it stands down, rather than writing beside this run.
              if ((hello.generation ?? 0) < generation || generation === 0) {
                const nth = answers++;

                await step.sendEvent(
                  `live:${nth}`,
                  threadLive.create({ agent: ref, thread, generation }),
                );
              }

              break;
            }
            case threadLive.name: {
              const live = message.data as { generation?: number };

              if ((live.generation ?? 0) > generation) {
                applied.standDown = true;
              } else {
                // Somebody else is holding at this generation or below and
                // this run is the one with the thread's state, so it stays.
                unconfirmed = false;
              }

              break;
            }
          }
        }

        return applied;
      }

      // A run that started from an arrival takes that arrival as its first
      // entry, and asks whether anyone else already holds the thread.
      if (!resume) {
        const first = await applyBatch([
          {
            id: event.id ?? "",
            name: event.name,
            data: event.data,
            ts: event.ts ?? 0,
          } as unknown as UntypedInboxMessage,
        ]);

        await step.sendEvent(
          "hello",
          threadHello.create({ agent: ref, thread, generation, gen }),
        );

        await forward(first.appended);

        if (first.done) {
          return { thread, generation, ended: "done" as const };
        }
      } else {
        // The successor announces itself and waits for the final state. Both
        // are issued together, so the predecessor's answer cannot arrive
        // before the wait exists.
        let final: ThreadSnapshot | undefined;

        for (let attempt = 0; attempt <= handoverAttempts; attempt += 1) {
          const [heard] = await Promise.all([
            step.waitForSignal<ThreadSnapshot>(`handover:${attempt}`, {
              signal: resume.signal,
              timeout: handoverTimeout,
              // Each announcement replaces the wait the last one left, which
              // is what makes retrying a handover possible at all.
              onConflict: "replace",
            }),
            step.sendEvent(
              `ready:${attempt}`,
              threadReady.create({ agent: ref, thread, gen, generation }),
            ),
          ]);

          if (heard) {
            final = heard.data as ThreadSnapshot;

            break;
          }

          // **Rule 6**: retry on timeout, never end. Ending here orphans the
          // thread, which is worse than another announcement.
        }

        if (!final) {
          // **Rule 7**: a give-up is its own event, never the done path, so
          // nothing can borrow the ending that the loss checks exempt.
          await step.sendEvent(
            "lost",
            threadLost.create({
              agent: ref,
              thread,
              generation,
              why: `no handover after ${handoverAttempts + 1} announcements`,
            }),
          );

          return { thread, generation, ended: "lost" as const };
        }

        state = { ...final, gen: generation };

        // A listen recorded after the handover began is not in this run's
        // subscription, so the thread rolls over again to establish it.
        if (final.listens.length > (resume.state.listens ?? []).length) {
          await handOver(final.listens.length);
        }
      }

      /**
       * Asks for a successor, handing it everything this run holds.
       *
       * The whole log travels on this event. Past 4MB the event is rejected
       * and the thread is lost: there is no store to spill to, and that is
       * accepted rather than worked around.
       */
      async function handOver(nonce: number) {
        if (handing) {
          return;
        }

        const next = generation + 1;
        const nextGen = generationKey(thread, next);
        const signal = handoverSignal(ref, nextGen);

        await step.sendEvent(`resume:${next}:${nonce}`, {
          ...threadResume.create({
            agent: ref,
            thread,
            gen: nextGen,
            generation: next,
            state,
            signal,
          }),
        });

        handing = { signal, generation: next };
      }

      let ended: "done" | "rolled" | "stood-down" = "done";

      for (;;) {
        if (!handing && (stepsIssued() ?? 0) >= rolloverSteps) {
          await handOver(0);
        }

        const batch = await inbox.nextBatch();

        if (!batch) {
          // The inbox closed, which only this run does.
          break;
        }

        const applied = await applyBatch(batch);

        await forward(applied.appended);

        if (applied.standDown) {
          // A later generation holds this thread. Everything this run saw, the
          // older holder saw too - it has been subscribed longer - so there is
          // nothing to hand over and nothing to lose by ending.
          logger.debug(
            { thread, generation },
            "another thread run holds this thread, standing down",
          );
          ended = "stood-down";

          break;
        }

        if (applied.done) {
          ended = "done";

          break;
        }

        // Applying what is left and ending are **one path**, not two: the
        // final state is what this run applied, and sending it is the last
        // thing it does. Two paths here is a real livelock.
        if (applied.ready && handing) {
          const unread = await inbox.drain();
          const last = await applyBatch(unread);

          await forward(last.appended);
          await inbox.close();

          const trailing = await applyBatch(await inbox.drain());

          await forward(trailing.appended);
          await step.sendSignal("final", {
            signal: handing.signal,
            data: state,
          });

          ended = "rolled";

          break;
        }

        if (applied.listened) {
          // A new listen only takes effect in a new subscription, so recording
          // one rolls the thread over. One mechanism rather than two.
          await handOver(state.listens.length);
        }
      }

      return { thread, generation, ended, entries: state.seq };
    },
  ) as InngestFunction.Any;
}
