import Debug from "debug";
import type { Simplify } from "../helpers/types.ts";
import { getAsyncCtx } from "./execution/als.ts";
import { gatewaySymbol, type InternalStepTools } from "./InngestStepTools.ts";

const globalFetch = globalThis.fetch;
type Fetch = typeof globalFetch;

export type StepFetch = Fetch &
  Simplify<
    {
      config: (options: StepFetch.Options) => StepFetch;
    } & Readonly<StepFetch.Options>
  >;

export namespace StepFetch {
  export interface Options {
    fallback?: Fetch | undefined;
  }

  export interface Extras extends Options {
    config: (options: Options) => StepFetch;
  }
}

const debug = Debug("inngest:fetch");

const createFetchShim = (): StepFetch => {
  // biome-ignore lint/style/useConst: need this to allow fns to be defined
  let stepFetch: StepFetch;

  const fetch: Fetch = async (input, init) => {
    const ctx = await getAsyncCtx();
    if (!ctx) {
      // Not in a function run
      if (!stepFetch.fallback) {
        // TODO Tell the user how to solve
        throw new Error(
          "step.fetch() called outside of a function and had no fallback set",
        );
      }

      debug(
        "step.fetch() called outside of a function; falling back to global fetch",
      );

      return stepFetch.fallback(input, init);
    }

    // In a function run
    if (ctx.executingStep) {
      // Inside a step
      if (!stepFetch.fallback) {
        // TODO Tell the user how to solve
        throw new Error(
          `step.fetch() called inside step "${ctx.executingStep.id}" and had no fallback set`,
        );
      }

      debug(
        `step.fetch() called inside step "${ctx.executingStep.id}"; falling back to global fetch`,
      );

      return stepFetch.fallback(input, init);
    }

    const targetUrl = new URL(
      input instanceof Request ? input.url : input.toString(),
    );

    debug("step.fetch() shimming request to", targetUrl.hostname);

    // Purposefully do not try/cacth this; if it throws then we treat that as a
    // regular `fetch()` throw, which also would not return a `Response`.
    const jsonRes = await (ctx.ctx.step as InternalStepTools)[gatewaySymbol](
      `step.fetch: ${targetUrl.hostname}`,
      input,
      init,
    );

    return new Response(jsonRes.body, {
      headers: jsonRes.headers,
      status: jsonRes.status,
    });
  };

  const optionsRef: StepFetch.Options = {
    fallback: globalFetch,
  };

  const extras: StepFetch.Extras = {
    config: (options) => {
      Object.assign(optionsRef, options);
      Object.assign(stepFetch, optionsRef);

      return stepFetch;
    },
    ...optionsRef,
  };

  stepFetch = Object.assign(fetch, extras);

  return stepFetch;
};

/**
 * `fetch` is a Fetch API-compatible function that can be used to make any HTTP
 * code durable if it's called within an Inngest function.
 *
 * It will gracefully fall back to the global `fetch` if called outside of this
 * context, and a custom fallback can be set using the `config` method.
 *
 * @example Basic usage
 * ```ts
 * import { fetch } from "inngest";
 *
 * const api = new MyProductApi({ fetch });
 * ```
 *
 * @example Setting a custom fallback
 * ```ts
 * import { fetch } from "inngest";
 *
 * const api = new MyProductApi({
 *            fetch: fetch.config({ fallback: myCustomFetch }),
 * });
 * ```
 *
 * @example Do not allow fallback
 * ```ts
 * import { fetch } from "inngest";
 *
 * const api = new MyProductApi({
 *            fetch: fetch.config({ fallback: undefined }),
 * });
 * ```
 */
export const fetch = createFetchShim();
