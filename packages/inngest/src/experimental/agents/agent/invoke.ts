/**
 * @module
 * EXPERIMENTAL: how one agent starts another and waits for its result, for
 * `callAgent()` and the discovery tools. It is a `step.invoke` to a function
 * reference, so the target resolves the way every `step.invoke` target does.
 * The call adds what an agent needs on top of it: the callee gets a thread of
 * its own and is told how deep in a chain of agents it is.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { referenceFunction } from "../../../components/InngestFunctionReference.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
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
 * Thrown when the agent a call started was cancelled (a stop now, a `cancelOn`
 * event, or the cancellation of the caller's own parent), so the caller never
 * takes a cancelled run's non-answer for a result. It is not retried. Inside
 * an agent tool, the loop reports a thrown error to the model as the tool's
 * result, as it does an `AgentLimitError`.
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
      `${target} was cancelled${run?.runId ? ` (run ${run.runId})` : ""}, so it returned no result.`,
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
 * How many agents deep an invoked function is: 1 for one started by a function
 * that is not an agent, 2 for the next, and so on. 0 for an event that did
 * not come from an agent call.
 */
export const invokeDepthOf = (
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
      `An agent address is "appId/functionId"; got ${JSON.stringify(target)}`,
    );
  }

  return { appId, functionId };
};

/**
 * Starts an agent and waits for its result.
 */
export async function invokeAgent(
  /**
   * The agent, or its `"appId/functionId"`.
   */
  agentOrRef: string | { ref: string },

  /**
   * The agent's input, or a function of the thread key the call chose that
   * returns it.
   */
  data: Record<string, unknown> | ((thread: string) => Record<string, unknown>),

  /**
   * The step ID. Default: `agent:invoke:<target>`.
   */
  options: { id?: string },
): Promise<unknown> {
  const target = typeof agentOrRef === "string" ? agentOrRef : agentOrRef.ref;
  const { appId, functionId } = parseTarget(target);
  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    throw new Error("An agent call must be made inside an Inngest function");
  }

  const { ctx, instance } = execution;
  const info = (ctx.event as { data?: Record<string, unknown> }).data?.[
    invokeKey
  ];
  const limits = limitStateOf(instance, readInheritedLimits(info));

  if (limits) {
    checkInvoke(limits, target);
  }

  const n = nextCount(instance, "invoke");

  const parent = currentSessions(ctx);
  const sessions = {
    agent_session: parent.agent_session ?? ctx.runId,
    agent_thread: `${functionId}:${ctx.runId}.${n}`,
  };
  const depth = invokeDepthOf(ctx.event as { data?: Record<string, unknown> });
  const id = options.id ?? `agent:invoke:${target}`;

  const result = await step.invoke(
    { id, name: `invoke ${target}` },
    {
      function: referenceFunction({ appId, functionId }),
      data: {
        ...(typeof data === "function" ? data(sessions.agent_thread) : data),
        [invokeKey]: {
          depth: depth + 1,
          thread: sessions.agent_thread,
          parent: ctx.runId,
          ...(limits && { limits: childLimits(limits) }),
        },
      },
      meta: { sessions },
    },
  );

  const cancelled = cancelledRun(result);

  if (cancelled) {
    throw new AgentCancelledError(target, cancelled);
  }

  return result;
}
