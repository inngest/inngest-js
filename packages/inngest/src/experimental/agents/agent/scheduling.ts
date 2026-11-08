/**
 * @module
 * EXPERIMENTAL: what a run can leave behind for its thread when it ends:
 *
 * - a listen rule (`me.listen()`): a hidden function, `agents-listen`, sits in
 *   `step.subscribe()` for events that match the rule and sends each one to the
 *   thread as an ordinary `agent/message`, so a new run starts for it when none
 *   is live. `me.unlisten()` cancels it.
 * - a wake (`me.wake()`): a hidden function, `agents-wake`, sleeps and then
 *   messages the thread `{ wake: name }`. `me.cancelWake()` cancels it.
 *
 * Both are mirrored in the thread's KV (`listen:<name>`, `wake:<name>`) so the
 * thread can show what it is waiting for. The mirror is for reading; the
 * functions are what act.
 */

import ms from "ms";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { inboxOpenedPromise } from "../../../components/inbox/Inbox.ts";
import {
  eventType,
  staticSchema,
} from "../../../components/triggers/triggers.ts";
import { agentMessage, type SenderData } from "../inbox/events.ts";
import type { Json } from "../json.ts";
import { kv, usesLedger } from "../kv/kv.ts";
import { threadSessions } from "../threads/thread.ts";
import { nextCount } from "./executionCounter.ts";

/**
 * How many matches one `agents-listen` run forwards before it hands over to a
 * fresh run of its own, so no run grows without bound.
 */
export const listenRollover = 200;

/**
 * How long the old run keeps forwarding after it started its successor, so no
 * event falls between the two. Forwards carry an ID made from the matched
 * event, so one both runs see is delivered once.
 */
const rolloverOverlap = "15s";

/**
 * The longest a rule lives when `ttl` is not given.
 */
const defaultListenTtl = "7d";

/**
 * What names the thread in every scheduling event.
 */
type Routing = {
  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string;

  /**
   * The thread key.
   */
  thread: string;
};

/**
 * The data of `agent/thread.listen`.
 */
export type ThreadListenData = Routing & {
  /**
   * The rule's name, unique in the thread.
   */
  name: string;

  /**
   * The name of the event to listen for.
   */
  event: string;

  /**
   * A CEL condition over the incoming event as `async`, such as
   * `async.data.pr == 42`.
   */
  if?: string;

  /**
   * When the rule ends, as an ISO timestamp.
   */
  until: string;

  /**
   * A fresh id for this listen.
   */
  id: string;

  /**
   * The id of the listen run of the same name this one replaces. Once this run
   * is listening, it cancels that one, so no event falls between the two.
   */
  replaces?: string;
};

/**
 * Starts a listen rule. Internal: `me.listen()` sends it.
 */
export const agentThreadListen = eventType("agent/thread.listen", {
  schema: staticSchema<ThreadListenData>(),
});

/**
 * Ends a listen rule. Internal: `me.unlisten()` sends it.
 */
export const agentThreadUnlisten = eventType("agent/thread.unlisten", {
  schema: staticSchema<Routing & { name: string }>(),
});

/**
 * Ends one listen run by its id. Internal: `me.listen()` sends it for the rule
 * it replaces.
 */
export const agentThreadCancelListen = eventType("agent/thread.cancelListen", {
  schema: staticSchema<Routing & { name: string; id: string }>(),
});

/**
 * The data of `agent/thread.wake`.
 */
export type ThreadWakeData = Routing & {
  /**
   * The wake's name.
   */
  name: string;

  /**
   * How long to sleep: a duration string like `"30s"`, or milliseconds.
   */
  after: string | number;

  /**
   * A fresh id for this wake, so a late cancel of an earlier wake of the same
   * name cannot end this one.
   */
  id: string;
};

/**
 * Arms a wake. Internal: `me.wake()` sends it.
 */
export const agentThreadWake = eventType("agent/thread.wake", {
  schema: staticSchema<ThreadWakeData>(),
});

/**
 * Cancels one wake. Internal: `me.cancelWake()` sends it.
 */
export const agentThreadCancelWake = eventType("agent/thread.cancelWake", {
  schema: staticSchema<Routing & { name: string; id: string }>(),
});

/**
 * The same thread, agent and name in the cancelling event as in the event
 * that started the function.
 */
const sameRule =
  "async.data.agent == event.data.agent && async.data.thread == event.data.thread && async.data.name == event.data.name";

/**
 * What is kept under `listen:<name>` in the thread's KV.
 */
export interface ListenRecord {
  event: string;
  if?: string;
  until: string;
  id: string;
}

/**
 * What is kept under `wake:<name>` in the thread's KV.
 */
export interface WakeRecord {
  id: string;
  after: string | number;
}

const nameProblem = (kind: string, name: string): string | undefined => {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(name)
    ? undefined
    : `A ${kind} name uses letters, digits and _ . : - only, up to 64 characters (got "${name}")`;
};

/**
 * Forwards to the thread as an ordinary `agent/message`. `from` names the rule
 * or wake that made it.
 */
const forward = (
  routing: Routing,
  content: Json,
  id: string,
  from: { listen: string; runId?: string } | { wake: string; runId?: string },
) => {
  return agentMessage.create(
    {
      agent: routing.agent,
      thread: routing.thread,
      content,
      from: from as unknown as SenderData,
    },
    { id, meta: { sessions: threadSessions(routing.thread) } },
  );
};

/**
 * The hidden function that holds a listen rule open. It stays pending until the
 * rule's `ttl` ends, an `agent/thread.unlisten` for the same thread and name
 * cancels it, or it has forwarded `listenRollover` events and handed over.
 */
export const listenFunction = (client: Inngest.Any): InngestFunction.Any => {
  return client.createFunction(
    {
      id: "agents-listen",
      cancelOn: [
        { event: agentThreadUnlisten.name, if: sameRule },
        {
          event: agentThreadCancelListen.name,
          if: `${sameRule} && async.data.id == event.data.id`,
        },
      ],
      triggers: [{ event: agentThreadListen.name }],
    },
    async ({ event, step, runId }) => {
      const rule = event.data as ThreadListenData;
      const routing = { agent: rule.agent, thread: rule.thread };

      await using inbox = step.subscribe("rule", {
        event: rule.event,
        ...(rule.if !== undefined && { if: rule.if }),
      });

      await inboxOpenedPromise(inbox);

      // A rule of the same name is replaced: this run is listening now, so
      // the old one is cancelled by its own id, which this run does not have.
      if (rule.replaces) {
        await step.sendEvent(
          "replace",
          agentThreadCancelListen.create({
            ...routing,
            name: rule.name,
            id: rule.replaces,
          }),
        );
      }

      const send = (
        n: number,
        matched: { id?: string; name: string; ts?: number; data: unknown },
      ) => {
        // The ID is made from the matched event, so the old and the new run
        // of a rollover deliver an event they both saw once.
        const id = `listen:${rule.thread}:${rule.name}:${matched.id ?? n}`;

        return step.sendEvent(
          `forward:${n}`,
          forward(
            routing,
            {
              event: {
                id: matched.id ?? null,
                name: matched.name,
                ts: matched.ts ?? null,
                data: matched.data as Json,
              },
            },
            id,
            { listen: rule.name, runId },
          ),
        );
      };

      for (let n = 0; n < listenRollover; n++) {
        const matched = await inbox.next({ timeout: rule.until });

        // `null`: the rule's time is up.
        if (!matched) {
          return { ended: "ttl", forwarded: n };
        }

        await send(n, matched);
      }

      // The successor is sent first, then this run keeps reading for a short
      // while, so nothing falls in the gap.
      await step.sendEvent(
        "rollover",
        agentThreadListen.create({ ...rule, replaces: undefined }),
      );

      let more = listenRollover;

      for (;;) {
        const matched = await inbox.next({ timeout: rolloverOverlap });

        if (!matched) {
          return { ended: "rollover", forwarded: more };
        }

        await send(more++, matched);
      }
    },
  );
};

/**
 * The hidden function that sleeps and then wakes the thread. A matching
 * `agent/thread.cancelWake` (same thread, name and id) cancels it.
 */
export const wakeFunction = (client: Inngest.Any): InngestFunction.Any => {
  return client.createFunction(
    {
      id: "agents-wake",
      cancelOn: [
        {
          event: agentThreadCancelWake.name,
          if: `${sameRule} && async.data.id == event.data.id`,
        },
      ],
      triggers: [{ event: agentThreadWake.name }],
    },
    async ({ event, step, runId }) => {
      const wake = event.data as ThreadWakeData;
      const routing = { agent: wake.agent, thread: wake.thread };

      await step.sleep("sleep", wake.after);

      // The mirror goes with the wake, unless a later wake of the name has
      // taken its place. The ledger cannot be written from here.
      if (!usesLedger(client.id)) {
        const scope = kv.with(client).scope("thread", wake.thread);
        const found = (await scope.get(`wake:${wake.name}`)) as
          | WakeRecord
          | null
          | undefined;

        if (found?.id === wake.id) {
          await scope.delete(`wake:${wake.name}`);
        }
      }

      const at = await step.run("at", () => {
        return new Date().toISOString();
      });

      await step.sendEvent(
        "fire",
        forward(routing, { wake: { name: wake.name, at } }, `wake:${wake.id}`, {
          wake: wake.name,
          runId,
        }),
      );
    },
  );
};

/**
 * The step tools the scheduling methods use.
 */
interface Step {
  sendEvent(id: string, payload: unknown): Promise<unknown>;
  run(id: string, fn: () => unknown): Promise<unknown>;
}

/**
 * The scheduling half of `Me`: the methods of a run's own thread that leave a
 * rule or a timer behind.
 */
export const createScheduling = (
  /**
   * The run's thread.
   */
  routing: Routing,

  /**
   * The run's step tools.
   */
  step: Step,
  client: Inngest.Any,
) => {
  const scope = () => {
    return kv.with(client).scope("thread", routing.thread);
  };

  const count = (kind: string): { n: number; runId: string } => {
    const execution = getAsyncCtxSync()?.execution;

    if (!execution) {
      throw new Error(`me.${kind}() must be called inside the run`);
    }

    return {
      n: nextCount(execution.instance, `me.${kind}`),
      runId: String(execution.ctx.runId),
    };
  };

  return {
    async listen(
      name: string,
      options: { event: string; if?: string; ttl?: string | number },
    ): Promise<void> {
      const problem = nameProblem("listen", name);

      if (problem) {
        throw new Error(problem);
      }

      const { n, runId } = count("listen");
      const ttl = ms(
        (options.ttl ?? defaultListenTtl) as Parameters<typeof ms>[0],
      );

      if (typeof ttl !== "number" || !(ttl > 0)) {
        throw new Error(`me.listen() ttl is not a duration: ${options.ttl}`);
      }

      const existing = await scope().get(`listen:${name}`);

      // The clock is read inside a step, so a replay keeps the same end.
      const record = (await step.run(`me:listen:${n}:rule`, () => {
        return {
          event: options.event,
          ...(options.if !== undefined && { if: options.if }),
          until: new Date(Date.now() + ttl).toISOString(),
          id: `${runId}.${n}`,
        };
      })) as ListenRecord;

      await scope().set(`listen:${name}`, record as unknown as Json);
      const previous = existing as ListenRecord | null | undefined;

      await step.sendEvent(
        `me:listen:${n}:send`,
        agentThreadListen.create({
          ...routing,
          name,
          ...record,
          // On a replay the record read is this listen's own.
          ...(previous &&
            previous.id !== record.id && { replaces: previous.id }),
        }),
      );
    },

    async unlisten(name: string): Promise<void> {
      const { n } = count("unlisten");

      await scope().delete(`listen:${name}`);
      await step.sendEvent(
        `me:unlisten:${n}`,
        agentThreadUnlisten.create({ ...routing, name }),
      );
    },

    async wake(name: string, after: string | number): Promise<void> {
      const problem = nameProblem("wake", name);

      if (problem) {
        throw new Error(problem);
      }

      const { n, runId } = count("wake");
      // A fresh id for every arming of a name.
      const id = `${runId}.${n}`;

      await scope().set(`wake:${name}`, { id, after } satisfies WakeRecord);
      await step.sendEvent(
        `me:wake:${n}`,
        agentThreadWake.create({ ...routing, name, after, id }),
      );
    },

    async cancelWake(name: string): Promise<void> {
      const { n } = count("cancelWake");
      const found = (await scope().get(`wake:${name}`)) as
        | WakeRecord
        | null
        | undefined;

      // Nothing armed under that name: nothing to cancel.
      if (!found) {
        return;
      }

      await scope().delete(`wake:${name}`);
      await step.sendEvent(
        `me:cancelWake:${n}`,
        agentThreadCancelWake.create({ ...routing, name, id: found.id }),
      );
    },
  };
};
