import { type AiAdapter } from "@inngest/ai";
import Debug from "debug";
import { getAsyncCtx } from "inngest/experimental";
import { type Simplify } from "../helpers/types.js";

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

  export interface Adapter extends AiAdapter {
    format: "fetch";
  }
}

const debug = Debug("inngest:fetch");

const createFetchShim = (): StepFetch => {
  // eslint-disable-next-line prefer-const
  let stepFetch: StepFetch;

  const fetch: Fetch = async (input, init) => {
    const ctx = await getAsyncCtx();
    if (!ctx) {
      // Not in a function run
      if (!stepFetch.fallback) {
        // TODO Tell the user how to solve
        throw new Error(
          "step.fetch() called outside of a function had and had no fallback set"
        );
      }

      debug(
        "step.fetch() called outside of a function; falling back to global fetch"
      );

      return stepFetch.fallback(input, init);
    }

    // In a function run
    if (ctx.executingStep) {
      // Inside a step
      if (!stepFetch.fallback) {
        // TODO Tell the user how to solve
        throw new Error(
          `step.fetch() called inside step "${ctx.executingStep.id}" had and had no fallback set`
        );
      }

      debug(
        `step.fetch() called inside step "${ctx.executingStep.id}"; falling back to global fetch`
      );

      return stepFetch.fallback(input, init);
    }

    const targetUrl = new URL(helpers.parseInputUrl(input));

    // Attempt to parse the body; `step.ai.infer()` assumes JSON
    let body: unknown = init?.body;
    if (body && typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        // Ignore parse error
      }
    }

    // Fetch a model unique to this request
    const model = fetchShimModel(input, init);

    debug("step.fetch() shimming request to", targetUrl.hostname);

    // TODO Better step ID?
    // TODO Must handle error and be able to reproduce the `Response`; atm this
    // assumes success and a <300 code
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await ctx.ctx.step.ai.infer(
      `step.fetch: ${targetUrl.hostname}`,
      { body, model }
    );

    // TODO Always stringify? Generic gateway should probably return just a
    // string anyway
    return new Response(JSON.stringify(result), {
      status: 200, // TODO not the real status
      // TODO Unknown headers
      headers: {
        "content-type": "application/json",
        "x-inngest-fetch": "true",
      },
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

export const fetchShimModel: AiAdapter.ModelCreator<
  Parameters<Fetch>,
  StepFetch.Adapter
> = (input, init) => {
  const url = helpers.parseInputUrl(input);

  const headers: Record<string, string> = {};
  if (input instanceof Request) {
    input.headers.forEach((value, key) => (headers[key] = value));
  } else if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((value, key) => (headers[key] = value));
  }

  return {
    format: "fetch",
    url,
    method: init?.method ?? "GET",
    headers,
    options: [input, init],
  } as StepFetch.Adapter;
};

const helpers = {
  parseInputUrl: (input: Parameters<Fetch>[0]) => {
    return input instanceof Request ? input.url : input.toString();
  },
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
