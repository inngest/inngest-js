/**
 * @module
 * EXPERIMENTAL: `agent.invoke()`, which starts another agent from inside a
 * function and returns its result. The agent is the one `createAgents()`
 * returned (its input is typed from its `invoke()` trigger and its result from
 * its body) or a plain `"appId/functionId"` string (untyped).
 *
 * It is a `step.invoke` to a function reference, so the target resolves the
 * way every `step.invoke` target does. The call adds what an agent needs on
 * top of it: the callee keeps the caller's session, gets a thread of its own,
 * and is told how deep in a chain of agents it is.
 */

import type { EventMeta } from "../../types.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import { referenceFunction } from "../InngestFunctionReference.ts";
import { step } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import type { AgentFunction } from "./agentFunction.ts";
import { nextCount } from "./executionCounter.ts";
import {
  checkInvoke,
  childLimits,
  limitStateOf,
  readInheritedLimits,
} from "./limits.ts";
import { currentSessions } from "./sessions.ts";

/**
 * The key of the invoke payload `data` that carries what the SDK tells an
 * invoked agent. The server only keeps `sessions` of the event meta, so the
 * depth travels here, like `_inngest` does for deferred functions.
 */
const invokeKey = "_agent";

/**
 * Options of `agent.invoke()`.
 */
export interface AgentInvokeOptions {
  /**
   * The ID of the step. Default: `agent:invoke:<target>`; calls with the same
   * ID in one run are numbered by the SDK.
   */
  id?: string;

  /**
   * The key of the callee's thread (`agent_thread`), chosen by the caller and
   * handed to the callee as `data._agent.thread`. Default:
   * `<functionId>:<runId>.<n>`, where `n` counts this run's `agent.invoke()`
   * calls, so a replay gives the same key.
   */
  thread?: string;

  /**
   * Event meta of the invocation. `meta.sessions` wins over the session and
   * thread this call sets, key by key.
   */
  meta?: EventMeta;

  /**
   * How long to wait for the callee, as for `step.invoke()`.
   */
  timeout?: number | string | Date;
}

/**
 * The `cancelOn` entry that ends a run when the run that invoked it is
 * cancelled. Put it in the `cancelOn` of an agent or function that only
 * `agent.invoke()` starts. A cancelled run sends `inngest/function.cancelled`,
 * which carries its own run ID, and `agent.invoke()` hands that ID to the
 * callee as `data._agent.parent`. A callee of the callee follows in turn.
 *
 * `agents.agent()` throws if an agent lists it while `on` has a trigger other
 * than `invoke()`: the expression reads `_agent`, which other events lack, and
 * the server then cancels the run when any other run is cancelled. Do not use
 * it on a plain function that other events also start for the same reason.
 * The check covers `on` only: a message sent to the agent's thread while it is
 * idle also starts a run without `_agent`, so only `agent.invoke()` should
 * start an agent that has this entry.
 */
export const agentInvokeCancelOn = {
  event: "inngest/function.cancelled",
  if: "event.data.run_id == async.data._agent.parent",
} as const;

/**
 * Thrown by `agent.invoke()` when the agent it started was cancelled (a stop
 * now, a `cancelOn` event, or the cancellation of the caller's own parent), so
 * the caller never takes a cancelled run's non-answer for a result. Code that
 * can carry on without the callee catches it; anything else lets it fail the
 * caller. It is not retried. Inside an agent tool, the loop reports a thrown
 * error to the model as the tool's result, as it does an `AgentLimitError`,
 * so the model reads that the agent was cancelled.
 */
export class AgentCancelledError extends NonRetriableError {
  /**
   * The ID of the function that was cancelled, as the executor reports it.
   */
  public readonly functionId: string | undefined;

  /**
   * The ID of the cancelled run.
   */
  public readonly runId: string | undefined;

  constructor(
    /**
     * The `"appId/functionId"` that was invoked.
     */
    target: string,
    /**
     * Which run was cancelled, when the executor says.
     */
    run?: { functionId?: string; runId?: string },
  ) {
    super(
      `agent.invoke(): ${target} was cancelled${run?.runId ? ` (run ${run.runId})` : ""}, so it returned no result.`,
    );
    this.name = "AgentCancelledError";
    this.functionId = run?.functionId;
    this.runId = run?.runId;
  }
}

/**
 * Reads what `step.invoke` gave back for a cancelled run. The executor
 * resumes the caller with the `inngest/function.finished` event of the run, not
 * with an output, when the run was cancelled; `undefined` for any other result.
 */
const cancelledRun = (
  /**
   * What the invoke step returned.
   */
  result: unknown,
): { functionId?: string; runId?: string } | undefined => {
  if (!isRecord(result) || result.name !== "inngest/function.finished") {
    return undefined;
  }

  const data = result.data;
  const info = isRecord(data) ? data._inngest : undefined;

  if (!isRecord(data) || !isRecord(info) || info.status !== "Cancelled") {
    return undefined;
  }

  return {
    functionId:
      typeof data.function_id === "string" ? data.function_id : undefined,
    runId: typeof data.run_id === "string" ? data.run_id : undefined,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/**
 * How many agents deep an invoked agent is: 1 for one started by a function
 * that is not an agent, 2 for the next, and so on. 0 for an event that did
 * not come from `agent.invoke()`.
 */
export const agentInvokeDepth = (
  /**
   * The event the function was started with.
   */
  event: { data?: Record<string, unknown> },
): number => {
  const info = event.data?.[invokeKey];
  const depth = isRecord(info) ? info.depth : undefined;

  return typeof depth === "number" && depth > 0 ? depth : 0;
};

/**
 * The data `agent.invoke()` was given, without the SDK's own key. Use it as
 * the input of an agent that other agents start. It returns a copy and leaves
 * the event as it is, so `agentInvokeDepth()` still works.
 */
export const agentInvokeInput = (
  /**
   * The event the function was started with.
   */
  event: { data?: Record<string, unknown> },
): Record<string, unknown> => {
  const { [invokeKey]: _info, ...input } = event.data ?? {};

  return input;
};

/**
 * Splits `"appId/functionId"` at its first slash.
 */
const parseTarget = (
  /**
   * The agent's address.
   */
  target: string,
): { appId: string; functionId: string } => {
  const slash = target.indexOf("/");
  const appId = target.slice(0, slash);
  const functionId = target.slice(slash + 1);

  if (slash < 1 || !functionId) {
    throw new Error(
      `agent.invoke() takes an agent as "appId/functionId"; got ${JSON.stringify(target)}`,
    );
  }

  return { appId, functionId };
};

/**
 * EXPERIMENTAL: Starts the agent `target` with `data` and waits for its
 * result. Call it inside a function. `target` is the agent, or
 * `"appId/functionId"` for one this code has no handle on. The callee finds
 * the thread this call names in `data._agent.thread`.
 *
 * If the callee is cancelled (a stop now, a `cancelOn` event), the call throws
 * an `AgentCancelledError`: the executor resumes the caller with the callee's
 * finish event instead of an output, and this call does not hand that over as
 * a result. The other way round, cancelling the caller
 * cancels an agent or function it invoked only if that one lists
 * `agentInvokeCancelOn` in its `cancelOn`.
 *
 * The agent runs in the caller's session (`agent_session`) on a new thread
 * (`agent_thread`). Without a session, the caller's run starts one. Other
 * sessions of the caller reach it through session propagation. The agent
 * can read how deep it is with `agentInvokeDepth(event)`.
 *
 * An agent's `limits` apply: a call they refuse throws an `AgentLimitError`
 * whose message says why, so inside a tool the model reads it as the result.
 * The agent started inherits the limits, narrowed.
 *
 * @example
 * ```ts
 * const found = await agent.invoke<{ answer: string }>("scout-app/researcher", {
 *   question,
 * });
 * ```
 */
export function invoke<TInput extends Record<string, unknown>, TOutput>(
  /**
   * The agent, as `createAgents()` returned it.
   */
  target: AgentFunction<TInput, TOutput>,

  /**
   * The agent's input.
   */
  data: TInput,

  /**
   * Step ID, thread key, meta and timeout.
   */
  options?: AgentInvokeOptions,
): Promise<TOutput>;
export function invoke<TOutput = unknown>(
  /**
   * The agent as `"appId/functionId"`, for one this code has no handle on.
   */
  target: string,

  /**
   * The agent's input. Untyped.
   */
  data?: Record<string, unknown>,

  /**
   * Step ID, thread key, meta and timeout.
   */
  options?: AgentInvokeOptions,
): Promise<TOutput>;
export async function invoke(
  agentOrRef: string | { ref: string },
  data: Record<string, unknown> = {},
  options: AgentInvokeOptions = {},
): Promise<unknown> {
  const target = typeof agentOrRef === "string" ? agentOrRef : agentOrRef.ref;
  const { appId, functionId } = parseTarget(target);
  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    throw new Error("agent.invoke() must be called inside an Inngest function");
  }

  const { ctx, instance } = execution;
  const info = (ctx.event as { data?: Record<string, unknown> }).data?.[
    invokeKey
  ];
  const limits = limitStateOf(instance, readInheritedLimits(info));

  if (limits) {
    checkInvoke(limits, target);
    limits.spawned += 1;
  }

  const n = nextCount(instance, "invoke");

  const parent = currentSessions(ctx);
  const sessions = {
    agent_session:
      execution.agent?.session ?? parent.agent_session ?? ctx.runId,
    agent_thread: options.thread ?? `${functionId}:${ctx.runId}.${n}`,
    ...options.meta?.sessions,
  };
  const depth = agentInvokeDepth(
    ctx.event as { data?: Record<string, unknown> },
  );
  const id = options.id ?? `agent:invoke:${target}`;

  const result = await step.invoke(
    { id, name: `invoke ${target}` },
    {
      function: referenceFunction({ appId, functionId }),
      data: {
        ...data,
        [invokeKey]: {
          depth: depth + 1,
          thread: sessions.agent_thread,
          parent: ctx.runId,
          ...(limits && { limits: childLimits(limits) }),
        },
      },
      meta: { ...options.meta, sessions },
      timeout: options.timeout,
    },
  );

  const cancelled = cancelledRun(result);

  if (cancelled) {
    throw new AgentCancelledError(target, cancelled);
  }

  return result;
}
