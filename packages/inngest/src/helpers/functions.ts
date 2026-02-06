import { ZodError, z } from "zod/v3";
import type { InngestApi } from "../api/api.ts";
import { stepsSchemas } from "../api/schema.ts";
import { PREFERRED_ASYNC_EXECUTION_VERSION } from "../components/execution/InngestExecution.ts";
import { err, ok, type Result } from "../types.ts";
import { ExecutionVersion } from "./consts.ts";
import { formatLogMessage, getLogger } from "./log.ts";
import type { Await } from "./types.ts";

/**
 * Wraps a function with a cache. When the returned function is run, it will
 * cache the result and return it on subsequent calls.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional
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
// biome-ignore lint/suspicious/noExplicitAny: intentional
export const waterfall = <TFns extends ((arg?: any) => any)[]>(
  fns: TFns,

  /**
   * A function that transforms the result of each function in the waterfall,
   * ready for the next function.
   *
   * Will not be called on the final function.
   */
  // biome-ignore lint/suspicious/noExplicitAny: intentional
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

export const versionSchema = z
  .literal(-1)
  .or(z.literal(0))
  .or(z.literal(1))
  .or(z.literal(2))
  .optional()
  .transform<{ version: ExecutionVersion; sdkDecided: boolean }>((v) => {
    if (typeof v === "undefined") {
      getLogger().debug(
        `No request version specified by executor; defaulting to v${PREFERRED_ASYNC_EXECUTION_VERSION}`,
      );

      return {
        sdkDecided: true,
        version: PREFERRED_ASYNC_EXECUTION_VERSION,
      };
    }

    if (v === -1) {
      return {
        sdkDecided: true,
        version: PREFERRED_ASYNC_EXECUTION_VERSION,
      };
    }

    return {
      sdkDecided: false,
      version: v,
    };
  });

const fnDataVersionSchema = z.object({
  version: versionSchema,
});

export const parseFnData = (data: unknown, headerVersion?: unknown) => {
  let version: ExecutionVersion | undefined;
  let sdkDecided: boolean;

  try {
    if (typeof headerVersion !== "undefined") {
      try {
        const res = versionSchema.parse(headerVersion);
        version = res.version;
        sdkDecided = res.sdkDecided;
      } catch {
        // no-op
      }
    }

    if (typeof version === "undefined") {
      const parsedVersionData = fnDataVersionSchema.parse(data);
      version = parsedVersionData.version.version;
      sdkDecided = parsedVersionData.version.sdkDecided;
    }

    const versionHandlers = {
      [ExecutionVersion.V0]: () =>
        ({
          version: ExecutionVersion.V0,
          sdkDecided,
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
          sdkDecided,
          ...z
            .object({
              event: z.record(z.any()),
              events: z.array(z.record(z.any())).default([]),
              steps: stepsSchemas[ExecutionVersion.V1],
              ctx: z
                .object({
                  run_id: z.string(),
                  fn_id: z.string().optional(),
                  attempt: z.number().default(0),
                  max_attempts: z.number().optional(),
                  disable_immediate_execution: z.boolean().default(false),
                  use_api: z.boolean().default(false),
                  qi_id: z.string().optional(),
                  stack: z
                    .object({
                      stack: z
                        .array(z.string())
                        .nullable()
                        .transform((v) => (Array.isArray(v) ? v : [])),
                      current: z.number(),
                    })
                    .optional()
                    .nullable(),
                })
                .optional()
                .nullable(),
            })
            .parse(data),
        }) as const,

      [ExecutionVersion.V2]: () =>
        ({
          version: ExecutionVersion.V2,
          sdkDecided,
          ...z
            .object({
              event: z.record(z.any()),
              events: z.array(z.record(z.any())).default([]),
              steps: stepsSchemas[ExecutionVersion.V2],
              ctx: z
                .object({
                  run_id: z.string(),
                  fn_id: z.string().optional(),
                  attempt: z.number().default(0),
                  max_attempts: z.number().optional(),
                  disable_immediate_execution: z.boolean().default(false),
                  use_api: z.boolean().default(false),
                  qi_id: z.string().optional(),
                  stack: z
                    .object({
                      stack: z
                        .array(z.string())
                        .nullable()
                        .transform((v) => (Array.isArray(v) ? v : [])),
                      current: z.number(),
                    })
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

  // Ugly pattern, but ensures we always check every execution model correctly.
  const shouldFetchData: Record<ExecutionVersion, () => boolean> = {
    [ExecutionVersion.V0]: () =>
      result.version === ExecutionVersion.V0 && result.use_api,
    [ExecutionVersion.V1]: () =>
      result.version === ExecutionVersion.V1 && Boolean(result.ctx?.use_api),
    [ExecutionVersion.V2]: () =>
      result.version === ExecutionVersion.V2 && Boolean(result.ctx?.use_api),
  };

  try {
    if (shouldFetchData[result.version]()) {
      if (!result.ctx?.run_id) {
        return err(
          formatLogMessage({
            message: "Failed to attempt retrieving data from API",
            explanation:
              "Function execution can't continue. run_id is missing from context.",
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
          formatLogMessage({
            message: "Failed to retrieve list of events",
            explanation: `Function execution can't continue.${evtResp.error?.error ? ` ${evtResp.error.error}` : ""}`,
          }),
        );
      }

      if (stepResp.ok) {
        result.steps = stepResp.value;
      } else {
        return err(
          formatLogMessage({
            message: "Failed to retrieve steps for function run",
            explanation: `Function execution can't continue.${stepResp.error?.error ? ` ${stepResp.error.error}` : ""}`,
          }),
        );
      }
    }

    // If we don't have a stack here, we need to at least set something.
    // TODO We should be passed this by the steps API.
    const stepIds = Object.keys(result.steps || {});
    if (stepIds.length && !result.ctx?.stack?.stack?.length) {
      result.ctx = {
        ...(result.ctx as NonNullable<typeof result.ctx>),
        stack: {
          stack: stepIds,
          current: stepIds.length - 1,
        },
      };
    }

    return ok(result);
  } catch (error) {
    getLogger().error(error);

    return err(parseFailureErr(error));
  }
};

const parseFailureErr = (err: unknown) => {
  let why: string | undefined;
  if (err instanceof ZodError) {
    why = err.toString();
  }

  return formatLogMessage({
    message: "Failed to parse data from executor",
    explanation: `Function execution can't continue.${why ? ` ${why}` : ""}`,
    action:
      "Make sure that your API is set up to parse incoming request bodies as JSON, like body-parser for Express.",
    docs: "https://expressjs.com/en/resources/middleware/body-parser.html",
  });
};
