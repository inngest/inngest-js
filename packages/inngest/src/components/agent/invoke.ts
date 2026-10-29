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
 * If the callee is stopped (a stop now cancels its run), the caller gets no
 * error: the executor completes the caller's run with a null output, as it
 * does for any `step.invoke` of a cancelled function, and the code after this
 * call does not run.
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
          ...(limits && { limits: childLimits(limits) }),
        },
      },
      meta: { ...options.meta, sessions },
      timeout: options.timeout,
    },
  );

  return result;
}
