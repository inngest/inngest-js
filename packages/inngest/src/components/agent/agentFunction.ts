/**
 * @module
 * EXPERIMENTAL: the agent function, an Inngest function whose body owns its
 * loop and reads a durable inbox. It adds what a plain function lacks for a
 * conversation that spans runs:
 *
 * - a singleton per thread, so there is never more than one live run per thread;
 * - a thread inbox (`inbox`) that keeps messages sent while the run works;
 * - `control`, which spreads into `agent.loop()` so a running turn takes
 *   steering messages and a stop request;
 * - a companion function that, once a run is over, clears its run-scoped KV
 *   and starts the next run when the inbox still holds unread messages.
 *
 * The public name of this entry point is not settled; it is exported from
 * `index.ts` in one line.
 */
import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import type { InboxStore } from "./inbox.ts";
import { defaultInboxStore } from "./inbox.ts";
import { kv as defaultKv, type Kv } from "./kv.ts";
import type { InboxMessage, Subscription } from "./subscribe.ts";
import {
  getThread,
  stopFlagKey,
  type ThreadHandle,
  type ThreadMessage,
  threadStartEvent,
  threadStopEvent,
} from "./thread.ts";

export interface AgentFunctionConfig {
  id: string;

  /**
   * The event that starts a run for a thread. Its `data.thread` is the thread
   * key; use `threads` (the handle) to send it, or send it yourself with
   * `meta.sessions.agent_thread`.
   */
  event: string;

  /**
   * Inbox store. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  store?: InboxStore;

  /**
   * KV store for thread state and run-scoped keys. Default: Redis at
   * `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  kv?: Kv;

  /**
   * Empty-wait interval of the inbox. Default `"5m"`.
   */
  recheck?: string | number;
}

/**
 * What the body gets, besides the usual function context.
 */
export interface AgentBodyContext {
  event: { name: string; data: { thread: string } & Record<string, unknown> };
  thread: ThreadHandle;

  /**
   * Messages sent to the thread, one per delivery, in order.
   */
  inbox: Subscription<ThreadMessage>;

  /**
   * Spread into `agent.loop()`: `steer` folds messages that arrived during a
   * turn into the next model call, and `stop` ends the loop once the thread's
   * stop flag is set.
   */
  control: {
    steer: () => Promise<string[]>;
    stop: () => Promise<boolean>;
  };
}

export type AgentBody = (context: AgentBodyContext) => Promise<unknown>;

/**
 * The agent function and its companion. Serve both.
 */
export interface AgentFunction {
  /**
   * The function that runs the body.
   */
  fn: InngestFunction.Any;

  /**
   * Runs after every run of `fn` ends: clears run-scoped KV and hands the
   * thread to a new run when its inbox has unread messages.
   */
  cleanup: InngestFunction.Any;

  /**
   * Both functions, ready to pass to `serve()`.
   */
  functions: InngestFunction.Any[];

  /**
   * The handle of a thread of this agent.
   * @param key Thread key.
   * @param session Session the thread belongs to. Default: the thread key.
   */
  thread(key: string, session?: string): ThreadHandle;
}

/**
 * EXPERIMENTAL: Defines an agent function.
 * @param client Inngest client.
 * @param config Function ID, trigger event and inbox options.
 * @param body Your loop. Read `inbox`, call `agent.loop()` with `control`.
 */
export function createAgentFunction(
  client: Inngest.Any,
  config: AgentFunctionConfig,
  body: AgentBody,
): AgentFunction {
  const store = () => config.store ?? defaultInboxStore();
  const kv = () => config.kv ?? defaultKv;
  const functionId = `${client.id}-${config.id}`;

  const fn = client.createFunction(
    {
      id: config.id,
      triggers: [{ event: config.event }],
      singleton: { key: "event.data.thread", mode: "skip" },
      cancelOn: [
        {
          event: threadStopEvent,
          if: "event.data.thread == async.data.thread",
        },
      ],
    },
    async (ctx) => {
      const { event, step } = ctx;
      const key = event.data.thread as string;
      const thread = getThread(client, key, {
        startEvent: config.event,
        store: config.store,
        kv: config.kv,
      });
      const inbox = step.subscribe<ThreadMessage>("inbox", {
        key,
        store: config.store,
        recheck: config.recheck,
      });

      const control = {
        async steer() {
          const lines: string[] = [];

          while (await inbox.pending()) {
            const message = (await inbox.next()) as InboxMessage<ThreadMessage>;
            lines.push(message.data.content);
          }

          return lines;
        },
        async stop() {
          return Boolean(await kv().get(stopFlagKey, { scope: "thread" }));
        },
      };

      return body({
        event: event as unknown as AgentBodyContext["event"],
        thread,
        inbox,
        control,
      });
    },
  );

  const cleanup = client.createFunction(
    {
      id: `${config.id}-cleanup`,
      triggers: [
        {
          event: "inngest/function.finished",
          if: `event.data.function_id == "${functionId}"`,
        },
      ],
    },
    async ({ event, step, sessions }) => {
      const data = event.data as {
        run_id: string;
        error?: unknown;
        event?: { data?: { thread?: string } };
      };
      const key = data.event?.data?.thread ?? sessions?.agent_thread;

      await step.run("clear-run-kv", async () => {
        const ids = { env: client.env ?? "default", app: client.id };

        await kv()
          .at("run", { ...ids, run: data.run_id })
          .clear();

        // A stop request ends with the run it stopped.
        if (key) {
          await kv()
            .at("thread", { ...ids, thread: key })
            .delete(stopFlagKey);
        }
      });

      if (!key || data.error !== undefined) {
        return { handoff: false };
      }

      const { head, acked } = await step.run("cursors", async () => {
        return store().cursors(key);
      });
      if (head <= acked) {
        return { handoff: false };
      }

      await step.sendEvent(
        "handoff",
        threadStartEvent(
          config.event,
          key,
          sessions?.agent_session ?? key,
          `handoff:${key}:${head}`,
        ),
      );

      return { handoff: true, head };
    },
  );

  return {
    fn,
    cleanup,
    functions: [fn, cleanup],
    thread(key, session) {
      return getThread(client, key, {
        startEvent: config.event,
        session,
        store: config.store,
        kv: config.kv,
      });
    },
  };
}
