/**
 * @module
 * EXPERIMENTAL: how code starts an agent: `agent.start(input)`. It opens a new
 * thread with a generated key and sends the input to it as a message, then
 * returns at once. `result()` waits for the run that takes it, through an
 * inbox opened before the send.
 * The sender rides in `data.from` with the chain depth and the callee's
 * thread. What the callee may do (limits it inherits, report routes, lend,
 * who started it) rides in one signed grant under `data["::agents"]`.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import type { Context } from "../../../types.ts";
import type { SenderData } from "../inbox/events.ts";
import { agentGroupJoined } from "../inbox/events.ts";
import {
  type AgentReportLine,
  type ReportSpec,
  resolveReports,
  routesOf,
  schemasOf,
} from "../inbox/reports.ts";
import type { Json } from "../json.ts";
import type { LentMachine } from "../sandboxes/defs.ts";
import {
  sendMessage,
  type ThreadHandle,
  threadHandle,
} from "../threads/thread.ts";
import { nextCount } from "./executionCounter.ts";
import {
  grantOfExecution,
  lendDigest,
  mintGrant,
  noteStarted,
  parentLine,
  proofOf,
  restrictionLines,
  routeLine,
  unattachedGrantSeconds,
} from "./grant.ts";
import { type LendOptions, parentEndedFunction, planLend } from "./lending.ts";
import { checkInvoke, childLimits, limitStateOf } from "./limits.ts";
import { groupId, relatedKey } from "./relations.ts";
import type { ResultOptions } from "./runResults.ts";
import { senderOf } from "./sender.ts";
import { currentSessions } from "./sessions.ts";

/**
 * How many agents deep a started run is: 1 for one started by a function that
 * is not an agent, 2 for the next, and so on. 0 for an event that did not come
 * from `start()`.
 */
export const invokeDepthOf = (
  /**
   * The event the function was started with.
   */
  event: { data?: Record<string, unknown> },
): number => {
  const from = event.data?.from as { depth?: unknown } | undefined;
  const depth = from?.depth;

  return typeof depth === "number" && depth > 0 ? depth : 0;
};

/**
 * The agent being started.
 */
export interface StartTarget {
  /**
   * The client of the app that defines the agent.
   */
  client: Inngest.Any;

  /**
   * The function ID.
   */
  id: string;

  /**
   * The address, `"appId/functionId"`.
   */
  address: string;

  /**
   * Whether the agent has an `invoke()` trigger: its input is then sent as that
   * trigger's data, not as the content of an `agent/message`.
   */
  typed: boolean;

  /**
   * Set for a run a model starts with `start_agent` (its end reaches the
   * model as an `agent/finished` message).
   */
  via?: "start_agent";

  /**
   * The thread to start the run on. Default: a new thread with a generated key.
   */
  thread?: string;

  /**
   * The name of the group the new thread joins, together with every thread the
   * same starter put in a group of that name. Needs a generated key, so it
   * cannot be set with `thread`.
   */
  group?: string;

  /**
   * The typed reports the agent is started to owe: event types, or
   * `{ event, to, if, required }` lines; a spec already resolved (from
   * `start_agent`) is passed as `resolved`.
   */
  reports?: readonly AgentReportLine[];

  /**
   * Reports already resolved into what travels in the start event.
   */
  resolved?: ReportSpec;
}

/**
 * The thread a `start()` opened.
 */
export interface StartedThread<TOutput = unknown>
  extends ThreadHandle<TOutput> {
  /**
   * Waits for the run `start()` began and gives its output. It throws when the
   * run failed or was stopped. With a `timeout` it throws an
   * `AgentTimeoutError` when the run is not done in time, and the run keeps
   * going; there is no default timeout. It works whenever it is called, and a
   * later `result()` keeps waiting for the same run.
   */
  result(options?: ResultOptions): Promise<TOutput>;
}

/**
 * What `start()` returns: a promise of the handle that also has its methods,
 * so `start(x).result()` needs one `await`.
 */
export type StartedThreadPromise<TOutput = unknown> = Promise<
  StartedThread<TOutput>
> &
  Pick<StartedThread<TOutput>, "result" | "stop" | "message" | "ask">;

/**
 * Schedules the defer that sends `agent/parent.ended` when this run ends for
 * good, once per run.
 */
const scheduled = new WeakSet<object>();

const scheduleParentEnded = (
  execution: NonNullable<ReturnType<typeof getAsyncCtxSync>>["execution"],
): void => {
  if (!execution || scheduled.has(execution.instance)) {
    return;
  }

  scheduled.add(execution.instance);

  const { ctx } = execution;
  const defer = (ctx as unknown as { defer: Context.Any["defer"] }).defer;

  defer("parent-ended", {
    function: parentEndedFunction(getAsyncCtxSync()?.app as Inngest.Any),
    data: { run_id: ctx.runId as string },
  });
};

/**
 * Starts the agent.
 * @param target The agent to start.
 * @param input Its input.
 */
export function startThread<TOutput>(
  target: StartTarget,
  input: unknown,
  lending: LendOptions = {},
): StartedThreadPromise<TOutput> {
  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    throw new Error("start() must be called inside an Inngest function");
  }

  const { ctx, instance } = execution;
  const limits = limitStateOf(instance, undefined);
  // The grant this run was started with: what the child's grant follows.
  const held = grantOfExecution(instance);

  if (limits) {
    checkInvoke(limits, target.address);
  }

  // What is lent is checked before anything is sent.
  const plan = planLend(lending);

  if (plan) {
    const app = (getAsyncCtxSync()?.app as { id?: string } | undefined)?.id;

    if (!target.address.startsWith(`${app}/`)) {
      throw new Error(
        `Tools and sandboxes can only be lent to an agent in the same app: "${target.address}" is not in "${app}"`,
      );
    }

    if (lending.attach === false) {
      throw new Error(
        "A child that borrows lent tools or sandboxes is tied to this run, so `attach: false` is not allowed",
      );
    }
  }

  const attached = lending.attach ?? plan !== undefined;

  const n = nextCount(instance, "start");
  if (target.group !== undefined && target.thread !== undefined) {
    throw new Error(
      "A start can join a group or use its own thread key, not both: a group is carried by the generated key.",
    );
  }

  // The address leads a generated key, so a tool that is given only the key
  // can tell which agent the thread belongs to. The key also carries a tag of
  // the thread that starts it (and of the group), which is how a model's
  // `message_agent` tells a parent, a child and a peer from a stranger.
  const sender = senderOf(execution);
  const starter = {
    key: sender.key,
    address: sender.kind === "agent" ? sender.address : "",
  };
  const key =
    target.thread ??
    relatedKey(
      target.client,
      `${target.address}:${ctx.runId}.${n}`,
      starter,
      target.group,
    );
  const reports =
    target.resolved ??
    (target.reports && target.reports.length > 0
      ? resolveReports(
          target.reports,
          sender.kind === "agent"
            ? { agent: sender.address, thread: sender.key }
            : undefined,
        )
      : undefined);
  const sessions = {
    agent_session: currentSessions(ctx).agent_session ?? (ctx.runId as string),
    agent_thread: key,
  };

  // An attached child is cancelled by the one `agent/parent.ended` this run
  // sends when it ends for good: the defer is scheduled once per run.
  if (attached) {
    scheduleParentEnded(execution);
  }

  noteStarted(instance, key);

  // A start is a message to the new thread: the sender carries the key of the
  // thread it opens, and one grant made for that thread carries what it
  // passes down. The result comes back to a private inbox opened before the
  // send, so no step waits for the child.
  const send = (lent?: Record<string, LentMachine>) => {
    const at = Math.floor(Date.now() / 1000);
    const grant = mintGrant(target.client, {
      ...(held && { parent: held }),
      thread: key,
      restrict: limits
        ? restrictionLines(childLimits(limits), held?.limits)
        : [],
      lines: [
        `iss=${(getAsyncCtxSync()?.app as { id?: string } | undefined)?.id ?? target.client.id}`,
        `iat=${at}`,
        // An attached child ends with the run that started it, which cancels
        // it. Any other lasts 7 days, and a message from its starter renews.
        ...(attached ? [] : [`until=${at + unattachedGrantSeconds}`]),
        ...(starter.address !== ""
          ? [parentLine(starter.address, starter.key)]
          : []),
        ...(attached ? [`run=${ctx.runId as string}`] : []),
        ...(reports ? routesOf(reports).map(routeLine) : []),
        ...(lent ? [`lend=${lendDigest(lent)}`] : []),
        ...(target.group !== undefined
          ? [
              `grp=${groupId(target.client, starter.key, target.group, starter.address)}`,
            ]
          : []),
      ],
    });

    return sendMessage<TOutput>(
      target.client,
      target.address,
      key,
      input as Json,
      {
        sessions,
        from: {
          thread: key,
          ...(target.typed && { typed: true }),
          ...(target.via && { via: target.via, target: target.address }),
          ...(reports &&
            Object.keys(reports).length > 0 && { reports: schemasOf(reports) }),
          ...(attached && { parent_run: ctx.runId as string }),
          ...(lent && { lent }),
        },
        agents: (id) => {
          return proofOf(target.client, grant, id, key);
        },
      },
    );
  };
  // Lending opens the lent sandboxes first (a step), so the send follows it.
  const call = plan
    ? (() => {
        const sent = plan.open().then(send);

        sent.catch(() => {});

        return Object.assign(
          sent.then(() => undefined),
          {
            result: (options?: ResultOptions) => {
              return sent.then((made) => {
                return made.result(options);
              });
            },
          },
        );
      })()
    : send();
  // One event tells every live member of the group about the new one.
  const joined =
    target.group === undefined
      ? undefined
      : step.sendEvent(
          `group:${ctx.runId}.${nextCount(instance, "group")}:joined`,
          agentGroupJoined.create({
            group: groupId(
              target.client,
              starter.key,
              target.group,
              starter.address,
            ),
            name: target.group,
            agent: target.address,
            thread: key,
          }),
        );
  const thread = threadHandle<TOutput>(target.client, target.address, key);
  const handle: StartedThread<TOutput> = {
    ...thread,
    result(options) {
      return call.result(options);
    },
  };
  const started = Promise.all([call, joined]).then(() => {
    return handle;
  });

  return Object.assign(started, {
    result: handle.result,
    stop: handle.stop,
    message: handle.message,
    ask: handle.ask,
  });
}
