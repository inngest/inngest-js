/**
 * @module
 * EXPERIMENTAL: what a model call costs, from prices you supply. The SDK knows
 * no prices: a `price` function, or a table of rates per model, turns the
 * tokens of each model call into US dollars, the loop adds them up, and a
 * `budget.usd` stops the thread like a token budget does.
 */
import type { AgentUsage } from "./loop.ts";

/**
 * USD for one model call. It gets that call's tokens and the model that
 * answered (what the `model` function put in `model` of its reply), and must be
 * pure: it runs again when a run replays.
 */
export type AgentPriceFunction = (
  usage: AgentUsage,
  model: string | undefined,
) => number;

/**
 * Rates in USD per million tokens, by model name. `"*"` is the rate for any
 * model not named.
 */
export type AgentPriceTable = Record<
  string,
  {
    /**
     * USD per million input tokens.
     */
    input: number;

    /**
     * USD per million output tokens.
     */
    output: number;
  }
>;

/**
 * How to price a model call: a function, or a table of rates per model.
 */
export type AgentPrice = AgentPriceFunction | AgentPriceTable;

const checked = (cost: number): number => {
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error(
      `price must give a number of dollars from 0 up, and gave ${cost}`,
    );
  }

  return cost;
};

/**
 * The cost in USD of one model call. A table with no rate for the model (and
 * no `"*"`) throws, since a call that costs nothing would let a dollar budget
 * go on forever.
 */
export const priceOf = (
  price: AgentPrice,
  usage: AgentUsage,
  model: string | undefined,
): number => {
  if (typeof price === "function") {
    return checked(price(usage, model));
  }

  const rate =
    (model !== undefined && Object.hasOwn(price, model)
      ? price[model]
      : undefined) ?? price["*"];

  if (!rate) {
    throw new Error(
      `price has no rate for the model ${model === undefined ? "(the reply named none)" : `"${model}"`}: add it, or a "*" rate for any other`,
    );
  }

  return checked(
    (usage.input * rate.input + usage.output * rate.output) / 1_000_000,
  );
};
