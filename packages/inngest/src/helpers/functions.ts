import { type InngestFunction } from "inngest/components/InngestFunction";
import { ZodError, z } from "zod";
import { type InngestApi } from "../api/api";
import { stepsSchemas } from "../api/schema";
import {
  ExecutionVersion,
  PREFERRED_EXECUTION_VERSION,
} from "../components/execution/InngestExecution";
import { err, ok, type Result } from "../types";
import { prettyError } from "./errors";
import { type Await } from "./types";

/**
 * Wraps a function with a cache. When the returned function is run, it will
 * cache the result and return it on subsequent calls.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cacheFn = <T extends (...args: any[]) => any>(fn: T): T => {
  const key = "value";
  const cache = new Map<typeof key, unknown>();

  return ((...args) => {
    if (!cache.has(key)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const waterfall = <TFns extends ((arg?: any) => any)[]>(
  fns: TFns,

  /**
   * A function that transforms the result of each function in the waterfall,
   * ready for the next function.
   *
   * Will not be called on the final function.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transform?: (prev: any, output: any) => any
): ((...args: Parameters<TFns[number]>) => Promise<Await<TFns[number]>>) => {
  return (...args) => {
    const chain = fns.reduce(async (acc, fn) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const prev = await acc;
      const output = (await fn(prev)) as Promise<Await<TFns[number]>>;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return transform ? await transform(prev, output) : output;
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

const fnDataVersionSchema = z.object({
  version: z
    .literal(-1)
    .or(z.literal(0))
    .or(z.literal(1))
    .optional()
    .transform<ExecutionVersion>((v) => {
      if (typeof v === "undefined") {
        console.debug(
          `No request version specified by executor; defaulting to v${PREFERRED_EXECUTION_VERSION}`
        );

        return PREFERRED_EXECUTION_VERSION;
      }

      return v === -1 ? PREFERRED_EXECUTION_VERSION : v;
    }),
});

export const parseFnData = (fn: InngestFunction.Any, data: unknown) => {
  let version: ExecutionVersion;

  try {
    ({ version } = fnDataVersionSchema.parse(data));

    const versionHandlers = {
      [ExecutionVersion.V0]: () =>
        ({
          version: ExecutionVersion.V0,
          ...z
            .object({
              event: z.record(z.any()),
              events: z.array(z.record(z.any())).default([]),
              steps: stepsSchemas[ExecutionVersion.V0],
              ctx: z
                .object({
                  run_id: z.string(),
                  attempt: z.number().default(0),
                  stack: z
                    .object({
                      stack: z
                        .array(z.string())
                        .nullable()
                        .transform((v) => (Array.isArray(v) ? v : [])),
                      current: z.number(),
                    })
                    .passthrough()
                    .optional()
                    .nullable(),
                })
                .optional()
                .nullable(),
              use_api: z.boolean().default(false),
            })
            .parse(data),
        }) as const,

      [ExecutionVersion.V1]: () =>
        ({
          version: ExecutionVersion.V1,
          ...z
            .object({
              event: z.record(z.any()),
              events: z.array(z.record(z.any())).default([]),
              steps: stepsSchemas[ExecutionVersion.V1],
              ctx: z
                .object({
                  run_id: z.string(),
                  attempt: z.number().default(0),
                  disable_immediate_execution: z.boolean().default(false),
                  use_api: z.boolean().default(false),
                  stack: z
                    .object({
                      stack: z
                        .array(z.string())
                        .nullable()
                        .transform((v) => (Array.isArray(v) ? v : [])),
                      current: z.number(),
                    })
                    .passthrough()
                    .optional()
                    .nullable(),
                })
                .optional()
                .nullable(),
            })
            .parse(data),
        }) as const,
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
          })
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
          })
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
          })
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
  if (err instanceof ZodError) {
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
