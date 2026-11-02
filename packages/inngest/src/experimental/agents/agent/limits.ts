/**
 * @module
 * EXPERIMENTAL: what an agent may start and spend. An agent declares `limits`
 * (`depth` and `mayCall`) and a `budget` in its config. Calls to other agents
 * enforce `depth` and `mayCall`, and an agent it starts inherits those
 * narrowed, so a sub-agent is never allowed more than its parent. The budget
 * is the agent's own: each thread has the budget of its own agent's
 * definition, which the loop always enforces, and it is never handed down.
 *
 * Limits gate calls made through the SDK only. A raw `step.invoke` or
 * `sendEvent` to another agent is not checked.
 */
import type { AgentUsage } from "../loop/loop.ts";

/**
 * How much a thread may spend. A field left out is not limited. The thread's
 * usage counts every model call of the thread, across runs.
 */
export interface AgentBudget {
  /**
   * Input plus output tokens.
   */
  tokens?: number;

  /**
   * Input tokens.
   */
  input?: number;

  /**
   * Output tokens.
   */
  output?: number;

  /**
   * Cost in US dollars, summed from what each model call cost. The model
   * reports its own cost when it knows its prices (`anthropic()` does);
   * the agent's `price` overrides it, and a model that reports no cost counts
   * nothing toward the budget until it has one.
   */
  usd?: number;
}

/**
 * What an agent may start and spend. Every field is optional.
 */
export interface AgentLimits {
  /**
   * How many levels of sub-agents may start below this agent. Default 1: the
   * agent may start sub-agents and they may not start any. A sub-agent gets
   * this minus one at most.
   */
  depth?: number;

  /**
   * The agents this agent may start, as exact `"appId/functionId"`
   * addresses (`"research/coder"`). Default: any. A sub-agent may
   * start only agents that match its parent's list and its own.
   */
  mayCall?: string[];
}

/**
 * What an agent runs with after its own `limits` are narrowed by the limits
 * of the agent that started it. This is what travels in the invoke payload.
 * The budget is not part of it.
 */
export interface EffectiveLimits {
  /**
   * Levels of sub-agents still allowed below. 0 means none.
   */
  depth?: number;

  /**
   * One list per agent in the chain that set `mayCall`. A target must match
   * every list.
   */
  mayCall?: string[][];
}

/**
 * Thrown when a limit refuses a call to another agent. The message says
 * which limit and why, so a model reading it as a tool error can react.
 */
export class AgentLimitError extends Error {
  public readonly limit: "depth" | "mayCall" | "budget";

  constructor(
    /**
     * Which limit refused the call.
     */
    limit: AgentLimitError["limit"],
    /**
     * What was refused and why.
     */
    message: string,
  ) {
    super(message);
    this.name = "AgentLimitError";
    this.limit = limit;
  }
}

/**
 * The running state of one execution's limits: what applies, and what the thread
 * has spent so far.
 */
export interface LimitState {
  limits: EffectiveLimits;

  /**
   * The thread's budget, from its own agent's definition.
   */
  budget?: AgentBudget;
  used: AgentUsage;
}

const budgetFields = ["tokens", "input", "output", "usd"] as const;

/**
 * Dollars for a message: cents when it is a cent or more, else two significant
 * digits, so $0.000030 does not show as $0.00.
 */
const dollars = (amount: number): string => {
  return amount >= 0.01 || amount === 0
    ? amount.toFixed(2)
    : amount.toPrecision(2);
};

/**
 * What the thread has spent, field by field.
 */
const spentOf = (used: AgentUsage) => {
  return {
    tokens: used.input + used.output,
    input: used.input,
    output: used.output,
    usd: used.usd ?? 0,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/**
 * The smaller of two optional caps.
 */
const lower = (
  /**
   * One cap.
   */
  x: number | undefined,

  /**
   * Another.
   */
  y: number | undefined,
) => {
  // `Infinity` means no cap, and cannot travel in JSON, so it is left out.
  const a = x !== undefined && Number.isFinite(x) ? x : undefined;
  const b = y !== undefined && Number.isFinite(y) ? y : undefined;

  if (a === undefined) {
    return b;
  }

  return b === undefined ? a : Math.min(a, b);
};

/**
 * The limits an agent runs with: its config, never wider than what it
 * inherited.
 */
export const narrowLimits = (
  /**
   * The agent's `limits`. Depth defaults to 1.
   */
  own: AgentLimits | undefined,

  /**
   * What the agent that started it passed down.
   */
  inherited: EffectiveLimits | undefined,
): EffectiveLimits => {
  const mayCall = [
    ...(inherited?.mayCall ?? []),
    ...(own?.mayCall ? [own.mayCall] : []),
  ];

  return {
    depth: lower(own?.depth, inherited?.depth) ?? 1,
    ...(mayCall.length > 0 && { mayCall }),
  };
};

/**
 * Combines two sets of inherited limits into the tighter of both, so a thread
 * started again by another agent never ends up with more than it had.
 */
export const narrowInherited = (
  /**
   * The limits stored on the thread, if any.
   */
  a: EffectiveLimits | undefined,

  /**
   * The limits of the new start, if any.
   */
  b: EffectiveLimits | undefined,
): EffectiveLimits | undefined => {
  if (!a || !b) {
    return a ?? b;
  }

  const seen = new Set<string>();
  const mayCall = [...(a.mayCall ?? []), ...(b.mayCall ?? [])].filter(
    (list) => {
      const key = JSON.stringify([...list].sort());

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    },
  );
  return {
    depth: lower(a.depth, b.depth),
    ...(mayCall.length > 0 && { mayCall }),
  };
};

/**
 * Reads the limits an invoking agent passed down, if any. It trusts only
 * well-formed numbers and strings, so a malformed payload never widens limits.
 */
export const readInheritedLimits = (
  /**
   * The `from` entry of the invoke payload.
   */
  info: unknown,
): EffectiveLimits | undefined => {
  const raw = isRecord(info) ? info.limits : undefined;

  if (raw !== undefined && !isRecord(raw)) {
    return { depth: 0 };
  }

  if (!isRecord(raw)) {
    return undefined;
  }

  // A field that is there but not a number closes the limit (0), so a bad
  // payload never widens what an agent may do.
  const number = (value: unknown) => {
    if (value === undefined) {
      return undefined;
    }

    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const mayCall =
    raw.mayCall !== undefined && !Array.isArray(raw.mayCall)
      ? [[]]
      : (raw.mayCall ?? []).map((list: unknown) => {
          return Array.isArray(list)
            ? list.filter((pattern): pattern is string => {
                return typeof pattern === "string";
              })
            : [];
        });

  return {
    depth: number(raw.depth),
    ...(mayCall.length > 0 && { mayCall }),
  };
};

/**
 * Why the budget is spent, or `undefined` while there is some left.
 */
export const budgetReason = (
  /**
   * The execution's limit state.
   */
  state: LimitState,
): string | undefined => {
  const budget = state.budget;

  if (!budget) {
    return undefined;
  }

  const spent = spentOf(state.used);

  for (const field of budgetFields) {
    const limit = budget[field];

    if (limit !== undefined && spent[field] >= limit) {
      return field === "usd"
        ? `Budget spent: $${dollars(spent.usd)} of $${dollars(limit)} used.`
        : `Budget spent: ${spent[field]} of ${limit} ${field === "tokens" ? "tokens" : `${field} tokens`} used.`;
    }
  }

  return undefined;
};

/**
 * Refuses a call to another agent that the limits do not allow, by throwing an
 * `AgentLimitError`.
 */
export const checkInvoke = (
  /**
   * The execution's limit state.
   */
  state: LimitState,
  /**
   * The agent to start, as `"appId/functionId"`.
   */
  target: string,
): void => {
  const { depth, mayCall } = state.limits;

  if (depth !== undefined && depth < 1) {
    throw new AgentLimitError(
      "depth",
      `Refused: ${target} was not started. This agent is too deep in a chain of agents to start another (limits.depth).`,
    );
  }

  for (const list of mayCall ?? []) {
    if (!list.includes(target)) {
      throw new AgentLimitError(
        "mayCall",
        `Refused: ${target} was not started. This agent may only start: ${list.join(", ") || "no agents"} (limits.mayCall).`,
      );
    }
  }

  const reason = budgetReason(state);

  if (reason) {
    throw new AgentLimitError(
      "budget",
      `Refused: ${target} was not started. ${reason}`,
    );
  }
};

/**
 * The limits to pass to an agent this execution starts: one level less depth.
 * The budget stays with this agent's thread.
 */
export const childLimits = (
  /**
   * The execution's limit state.
   */
  state: LimitState,
): EffectiveLimits => {
  const { depth, mayCall } = state.limits;

  return {
    ...(depth !== undefined && { depth: depth - 1 }),
    ...(mayCall && { mayCall }),
  };
};

/**
 * The limit state of each running execution. The agent function registers it
 * when its body starts; calls to other agents read it.
 */
const states = new WeakMap<object, LimitState>();

/**
 * Registers the limits an execution runs with.
 */
export const registerLimits = (
  /**
   * The execution (`getAsyncCtxSync().execution.instance`).
   */
  instance: object,

  /**
   * The agent's limits after narrowing.
   */
  limits: EffectiveLimits,

  /**
   * What the thread has spent so far.
   */
  used: AgentUsage,

  /**
   * The thread's budget.
   */
  budget?: AgentBudget,
): LimitState => {
  const state = { limits, used, ...(budget && { budget }) };

  states.set(instance, state);

  return state;
};

/**
 * The limit state of an execution, or the limits it inherited when it is not
 * an agent (a plain function an agent started), or `undefined` when nothing
 * limits it.
 */
export const limitStateOf = (
  /**
   * The execution.
   */
  instance: object,

  /**
   * What the invoking agent passed down, if anything.
   */
  inherited: EffectiveLimits | undefined,
): LimitState | undefined => {
  const found = states.get(instance);

  if (found || !inherited) {
    return found;
  }

  return registerLimits(instance, inherited, { input: 0, output: 0 });
};
