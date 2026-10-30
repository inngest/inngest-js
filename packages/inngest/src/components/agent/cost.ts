/**
 * @module
 * EXPERIMENTAL: what a model call costs, from prices you supply. The SDK knows
 * no prices: a `price` function, or a table of rates per model, turns the
 * tokens of each model call into US dollars, the loop adds them up, and a
 * `budget.usd` stops the thread like a token budget does.
 */
import { NonRetriableError } from "../NonRetriableError.ts";
import type { AgentUsage } from "./loop.ts";

/**
 * USD for one model call. It gets that call's tokens and the model that
 * answered (what the `model` function put in `model` of its reply). It runs
 * once for each model call, inside the call's step, and the loop keeps the
 * number it gave: a replay reuses it and does not call the function again, so
 * it may read a price list that changes. A number that is not dollars from 0 up
 * stops the run with a `NonRetriableError`, since a retry would price it the
 * same.
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

    /**
     * USD per million input tokens read from the prompt cache. Default: the
     * `input` rate.
     */
    cacheRead?: number;

    /**
     * USD per million input tokens written to the five-minute prompt cache.
     * Default: the `input` rate.
     */
    cacheWrite?: number;

    /**
     * USD per million input tokens written to the one-hour prompt cache.
     * Default: `cacheWrite`, then the `input` rate.
     */
    cacheWrite1h?: number;
  }
>;

/**
 * How to price a model call: a function, or a table of rates per model.
 */
export type AgentPrice = AgentPriceFunction | AgentPriceTable;

const checked = (cost: number): number => {
  if (!Number.isFinite(cost) || cost < 0) {
    throw new NonRetriableError(
      `price must give a number of dollars from 0 up, and gave ${cost}`,
    );
  }

  return cost;
};

/**
 * The cost in USD of one model call. A table with no rate for the model (and
 * no `"*"`) throws, since a call that costs nothing would let a dollar budget
 * go on forever. Both that and a result that is not dollars throw a
 * `NonRetriableError`.
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
    throw new NonRetriableError(
      `price has no rate for the model ${model === undefined ? "(the reply named none)" : `"${model}"`}: add it, or a "*" rate for any other`,
    );
  }

  // `input` counts the cached tokens too: price each kind at its own rate and
  // the rest at the plain one.
  const read = usage.cacheRead ?? 0;
  const written = usage.cacheWrite ?? 0;
  const written1h = Math.min(usage.cacheWrite1h ?? 0, written);
  const plain = Math.max(0, usage.input - read - written);

  return checked(
    (plain * rate.input +
      read * (rate.cacheRead ?? rate.input) +
      (written - written1h) * (rate.cacheWrite ?? rate.input) +
      written1h * (rate.cacheWrite1h ?? rate.cacheWrite ?? rate.input) +
      usage.output * rate.output) /
      1_000_000,
  );
};
