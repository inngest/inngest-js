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

/**
 * The cost in USD of one model call, or `undefined` when the table has no rate
 * for the model.
 */
export const priceOf = (
  price: AgentPrice,
  usage: AgentUsage,
  model: string | undefined,
): number | undefined => {
  if (typeof price === "function") {
    const cost = price(usage, model);

    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error(
        `price() must return a number of dollars from 0 up, and returned ${cost}`,
      );
    }

    return cost;
  }

  const rate =
    (model !== undefined && Object.hasOwn(price, model)
      ? price[model]
      : undefined) ?? price["*"];

  return rate
    ? (usage.input * rate.input + usage.output * rate.output) / 1_000_000
    : undefined;
};
