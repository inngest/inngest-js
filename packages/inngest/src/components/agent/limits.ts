/**
 * @module
 * EXPERIMENTAL: limits on what an agent may start and spend. An agent
 * declares `limits` in its config; `agent.invoke()` enforces `depth`, `spawn`
 * and `mayCall` and the loop enforces `budget`. An agent it starts inherits
 * the limits narrowed, so a sub-agent is never allowed more than its parent.
 *
 * Limits gate `agent.invoke()` only. A raw `step.invoke` or `sendEvent` to
 * another agent is not checked, and `budget` only stops a loop that is given
 * the body's `control` (see {@link AgentLimits.budget}).
 */
import type { AgentPrice } from "./cost.ts";
import type { AgentUsage } from "./loop.ts";

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
   * Cost in US dollars, summed from the prices of `limits.price`. An agent
   * that sets this needs a `limits.price`; `createAgentFunction()` throws
   * without one, since its calls would count nothing toward the budget. A budget
   * inherited from a parent needs the sub-agent's own `limits.price` too (a
   * price is a function and does not travel): its run fails without one.
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
   * The most `agent.invoke()` calls one run may make. A refused call does not
   * count. A sub-agent gets this as its own cap at most.
   */
  spawn?: number;

  /**
   * The agents this agent may start, as `"appId/functionId"` patterns where
   * `*` matches any text (`"research/*"`). Default: any. A sub-agent may
   * start only agents that match its parent's list and its own. It limits
   * `agent.invoke()` only: an agent in the `tools` of `agent.loop()` is
   * allowed by being listed there.
   */
  mayCall?: string[];

  /**
   * What the thread may spend. The loop stops with `stopped: "budget"` before
   * its next model call once it is spent. This only applies to a loop that is
   * passed `...control` (or `budget` and `onTurn` from it): a body that
   * calls `agent.loop()` without them runs with no budget at all. A
   * sub-agent gets what is left at most; the sub-agents' total is not capped,
   * so pair it with `spawn`.
   */
  budget?: AgentBudget;

  /**
   * What a model call costs, for `budget.usd`: a function of the call's tokens
   * and model that returns US dollars, or rates per million tokens by model
   * name. Spread `...control` into `agent.loop()` to use it. See `AgentPrice`.
   */
  price?: AgentPrice;
}

/**
 * What an agent runs with after its own `limits` are narrowed by the limits
 * of the agent that started it. This is what travels in the invoke payload.
 */
export interface EffectiveLimits {
  /**
   * Levels of sub-agents still allowed below. 0 means none.
   */
  depth?: number;
  spawn?: number;

  /**
   * One list per agent in the chain that set `mayCall`. A target must match
   * every list.
   */
  mayCall?: string[][];
  budget?: AgentBudget;
}

/**
 * Thrown by `agent.invoke()` when a limit refuses the call. The message says
 * which limit and why, so a model reading it as a tool error can react.
 */
export class AgentLimitError extends Error {
  public readonly limit: "depth" | "spawn" | "mayCall" | "budget";

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
 * The running state of one execution's limits: what applies, what the thread
 * has spent so far and how many sub-agents the run has started.
 */
export interface LimitState {
  limits: EffectiveLimits;
  used: AgentUsage;
  spawned: number;
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
 * The tighter of two budgets, field by field.
 */
const narrowBudget = (
  /**
   * One budget.
   */
  a: AgentBudget | undefined,

  /**
   * Another.
   */
  b: AgentBudget | undefined,
): AgentBudget | undefined => {
  const narrowed: AgentBudget = {};

  for (const field of budgetFields) {
    const value = lower(a?.[field], b?.[field]);

    if (value !== undefined) {
      narrowed[field] = value;
    }
  }

  return Object.keys(narrowed).length > 0 ? narrowed : undefined;
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
    spawn: lower(own?.spawn, inherited?.spawn),
    ...(mayCall.length > 0 && { mayCall }),
    budget: narrowBudget(own?.budget, inherited?.budget),
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
  const budget = narrowBudget(a.budget, b.budget);

  return {
    depth: lower(a.depth, b.depth),
    spawn: lower(a.spawn, b.spawn),
    ...(mayCall.length > 0 && { mayCall }),
    ...(budget && { budget }),
  };
};

/**
 * The limits without a dollar budget. A dollar budget handed down by a parent
 * belongs to the run it was handed to, so it is not kept on the thread: a
 * later run, started by a plain message, has no price to count it with.
 */
export const withoutUsdBudget = (
  limits: EffectiveLimits | undefined,
): EffectiveLimits | undefined => {
  if (!limits?.budget || limits.budget.usd === undefined) {
    return limits;
  }

  const { usd: _usd, ...budget } = limits.budget;
  const { budget: _budget, ...rest } = limits;

  return Object.keys(budget).length > 0 ? { ...rest, budget } : rest;
};

/**
 * Reads the limits an invoking agent passed down, if any. It trusts only
 * well-formed numbers and strings, so a malformed payload never widens limits.
 */
export const readInheritedLimits = (
  /**
   * The `_agent` entry of the invoke payload.
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
  const budget: AgentBudget = {};

  if (raw.budget !== undefined && !isRecord(raw.budget)) {
    budget.tokens = 0;
  } else if (isRecord(raw.budget)) {
    for (const field of budgetFields) {
      const value = number(raw.budget[field]);

      if (value !== undefined) {
        budget[field] = value;
      }
    }
  }

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
    spawn: number(raw.spawn),
    ...(mayCall.length > 0 && { mayCall }),
    ...(Object.keys(budget).length > 0 && { budget }),
  };
};

/**
 * Whether `target` matches a pattern, where `*` matches any text.
 */
export const matchesTarget = (
  /**
   * An allow-list entry such as `"research/*"`.
   */
  pattern: string,
  /**
   * The agent as `"appId/functionId"`.
   */
  target: string,
): boolean => {
  const source = pattern
    .split("*")
    .map((part) => {
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join(".*");

  return new RegExp(`^${source}$`).test(target);
};

/**
 * What is left of a budget after `used`, field by field, never below 0.
 */
const remaining = (
  /**
   * The budget.
   */
  budget: AgentBudget | undefined,

  /**
   * What the thread has spent.
   */
  used: AgentUsage,
): AgentBudget | undefined => {
  if (!budget) {
    return undefined;
  }

  const spent = spentOf(used);
  const left: AgentBudget = {};

  for (const field of budgetFields) {
    const limit = budget[field];

    if (limit !== undefined) {
      left[field] = Math.max(0, limit - spent[field]);
    }
  }

  return left;
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
  const budget = state.limits.budget;

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
 * Refuses an `agent.invoke()` the limits do not allow, by throwing an
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
  /**
   * How the agent is started. An agent used as a tool is allowed by being in
   * the caller's `tools`, so `mayCall` does not apply to it.
   */
  via: { asTool?: boolean } = {},
): void => {
  const { depth, spawn, mayCall } = state.limits;

  if (depth !== undefined && depth < 1) {
    throw new AgentLimitError(
      "depth",
      `Refused: ${target} was not started. This agent is too deep in a chain of agents to start another (limits.depth).`,
    );
  }

  if (spawn !== undefined && state.spawned >= spawn) {
    throw new AgentLimitError(
      "spawn",
      `Refused: ${target} was not started. This run already started ${spawn} agent${spawn === 1 ? "" : "s"}, the most it may (limits.spawn).`,
    );
  }

  for (const list of via.asTool ? [] : (mayCall ?? [])) {
    const allowed = list.some((pattern) => {
      return matchesTarget(pattern, target);
    });

    if (!allowed) {
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
 * The limits to pass to an agent this execution starts: one level less depth
 * and what is left of the budget.
 */
export const childLimits = (
  /**
   * The execution's limit state.
   */
  state: LimitState,
): EffectiveLimits => {
  const { depth, spawn, mayCall, budget } = state.limits;

  return {
    ...(depth !== undefined && { depth: depth - 1 }),
    ...(spawn !== undefined && { spawn }),
    ...(mayCall && { mayCall }),
    ...(budget && { budget: remaining(budget, state.used) }),
  };
};

/**
 * The limit state of each running execution. The agent function registers it
 * when its body starts; `agent.invoke()` reads it.
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
): LimitState => {
  const state = { limits, used, spawned: 0 };

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
