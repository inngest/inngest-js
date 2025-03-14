import * as v from "valibot";
import type { InngestApi } from "../api/api.ts";
import { stepsSchemas } from "../api/schema.ts";
import { PREFERRED_EXECUTION_VERSION } from "../components/execution/InngestExecution.ts";
import { type Result, err, ok } from "../types.ts";
import { ExecutionVersion } from "./consts.ts";
import { prettyError } from "./errors.ts";
import type { Await } from "./types.ts";

/**
 * Wraps a function with a cache. When the returned function is run, it will
 * cache the result and return it on subsequent calls.
 */
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export const cacheFn = <T extends (...args: any[]) => any>(fn: T): T => {
  const key = "value";
  const cache = new Map<typeof key, unknown>();

  return ((...args) => {
    if (!cache.has(key)) {
      cache.set(key, fn(...args));
    }

    return cache.get(key);
  }) as T;
};

/**
 * Given an array of functions, return a new function that will run each
 * function in series and return the result of the final function. Regardless of
 * if the functions are synchronous or asynchronous, they'll be made into an
 * async promise chain.
 *
 * If an error is thrown, the waterfall will stop and return the error.
 *
 * Because this needs to support both sync and async functions, it only allows
 * functions that accept a single argument.
 */
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export const waterfall = <TFns extends ((arg?: any) => any)[]>(
  fns: TFns,

  /**
   * A function that transforms the result of each function in the waterfall,
   * ready for the next function.
   *
   * Will not be called on the final function.
   */
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  transform?: (prev: any, output: any) => any,
): ((...args: Parameters<TFns[number]>) => Promise<Await<TFns[number]>>) => {
  return (...args) => {
    const chain = fns.reduce(async (acc, fn) => {
      const prev = await acc;
      const output = (await fn(prev)) as Promise<Await<TFns[number]>>;

      if (transform) {
        return await transform(prev, output);
      }

      if (typeof output === "undefined") {
        return prev;
      }

      return output;
    }, Promise.resolve(args[0]));

    return chain;
  };
};

/**
 * Given a value `v`, return `v` if it's not undefined, otherwise return `null`.
 */
export const undefinedToNull = (v: unknown) => {
  const isUndefined = typeof v === "undefined";
  return isUndefined ? null : v;
};

const FnDataVersion = v.object({
  version: v.optional(
    v.union([v.literal(0), v.literal(1), v.literal(2)]),
    PREFERRED_EXECUTION_VERSION,
  ),
});

export const parseFnData = (data: unknown) => {
  let version: ExecutionVersion;

  try {
    ({ version } = v.parse(FnDataVersion, data));

    const versionHandlers = {
      [ExecutionVersion.V0]: () => ({
        version: ExecutionVersion.V0 as const,
        ...v.parse(
          v.object({
            event: v.record(v.string(), v.any()),
            events: v.optional(v.array(v.record(v.string(), v.any())), []),
            steps: stepsSchemas[ExecutionVersion.V0],
            use_api: v.optional(v.boolean(), false),
            ctx: v.nullish(
              v.object({
                run_id: v.string(),
                attempt: v.optional(v.number(), 0),
                stack: v.nullish(
                  v.looseObject({
                    stack: v.nullable(
                      v.pipe(
                        v.array(v.string()),
                        v.transform((v) => (Array.isArray(v) ? v : [])),
                      ),
                    ),
                    current: v.number(),
                  }),
                ),
              }),
            ),
          }),
          data,
        ),
      }),

      [ExecutionVersion.V1]: () => ({
        version: ExecutionVersion.V1 as const,
        ...v.parse(
          v.object({
            event: v.record(v.string(), v.any()),
            events: v.optional(v.array(v.record(v.string(), v.any())), []),
            steps: stepsSchemas[ExecutionVersion.V1],
            ctx: v.nullish(
              v.object({
                run_id: v.string(),
                attempt: v.optional(v.number(), 0),
                disable_immediate_execution: v.optional(v.boolean(), false),
                use_api: v.optional(v.boolean(), false),
                stack: v.nullish(
                  v.looseObject({
                    stack: v.nullable(
                      v.pipe(
                        v.array(v.string()),
                        v.transform((v) => (Array.isArray(v) ? v : [])),
                      ),
                    ),
                    current: v.number(),
                  }),
                ),
              }),
            ),
          }),
          data,
        ),
      }),

      [ExecutionVersion.V2]: () => ({
        version: ExecutionVersion.V2 as const,
        ...v.parse(
          v.object({
            event: v.record(v.string(), v.any()),
            events: v.optional(v.array(v.record(v.string(), v.any())), []),
            steps: stepsSchemas[ExecutionVersion.V2],
            ctx: v.nullish(
              v.object({
                run_id: v.string(),
                attempt: v.optional(v.number(), 0),
                disable_immediate_execution: v.optional(v.boolean(), false),
                use_api: v.optional(v.boolean(), false),
                stack: v.nullish(
                  v.looseObject({
                    stack: v.nullable(
                      v.pipe(
                        v.array(v.string()),
                        v.transform((v) => (Array.isArray(v) ? v : [])),
                      ),
                    ),
                    current: v.number(),
                  }),
                ),
              }),
            ),
          }),
          data,
        ),
      }),
    } satisfies Record<ExecutionVersion, () => unknown>;

    return versionHandlers[version]();
  } catch (err) {
    throw new Error(parseFailureErr(err));
  }
};
export type FnData = ReturnType<typeof parseFnData>;

type ParseErr = string;
export const fetchAllFnData = async ({
  data,
  api,
  version,
}: {
  data: FnData;
  api: InngestApi;
  version: ExecutionVersion;
}): Promise<Result<FnData, ParseErr>> => {
  const result = { ...data };

  try {
    if (
      (result.version === ExecutionVersion.V0 && result.use_api) ||
      (result.version === ExecutionVersion.V1 && result.ctx?.use_api)
    ) {
      if (!result.ctx?.run_id) {
        return err(
          prettyError({
            whatHappened: "failed to attempt retrieving data from API",
            consequences: "function execution can't continue",
            why: "run_id is missing from context",
            stack: true,
          }),
        );
      }

      const [evtResp, stepResp] = await Promise.all([
        api.getRunBatch(result.ctx.run_id),
        api.getRunSteps(result.ctx.run_id, version),
      ]);

      if (evtResp.ok) {
        result.events = evtResp.value;
      } else {
        return err(
          prettyError({
            whatHappened: "failed to retrieve list of events",
            consequences: "function execution can't continue",
            why: evtResp.error?.error,
            stack: true,
          }),
        );
      }

      if (stepResp.ok) {
        result.steps = stepResp.value;
      } else {
        return err(
          prettyError({
            whatHappened: "failed to retrieve steps for function run",
            consequences: "function execution can't continue",
            why: stepResp.error?.error,
            stack: true,
          }),
        );
      }
    }

    return ok(result);
  } catch (error) {
    // print it out for now.
    // move to something like protobuf so we don't have to deal with this
    console.error(error);

    return err(parseFailureErr(error));
  }
};

const parseFailureErr = (err: unknown) => {
  let why: string | undefined;
  if (err instanceof v.ValiError) {
    why = err.toString();
  }

  return prettyError({
    whatHappened: "Failed to parse data from executor.",
    consequences: "Function execution can't continue.",
    toFixNow:
      "Make sure that your API is set up to parse incoming request bodies as JSON, like body-parser for Express (https://expressjs.com/en/resources/middleware/body-parser.html).",
    stack: true,
    why,
  });
};
