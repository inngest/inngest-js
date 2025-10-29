/**
 * An adapter for any request that handles standard Web APIs such as `fetch`,
 * `Request,` and `Response` to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * This is reused by many other adapters, but can be used directly.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/edge";
 * import functions from "~/inngest";
 *
 * export const handler = serve({ id: "my-edge-app", functions });
 * ```
 *
 * @module
 */

import { getAsyncLocalStorage } from "./components/execution/als";
import {
  type ExecutionResultHandlers,
  PREFERRED_EXECUTION_VERSION,
} from "./components/execution/InngestExecution";
import type { Inngest } from "./components/Inngest.ts";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { InngestFunction } from "./components/InngestFunction";
import { getAsyncCtx } from "./experimental";
import { ExecutionVersion, headerKeys } from "./helpers/consts";
import { ServerTiming } from "./helpers/ServerTiming";
import type { SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "edge";

export type EdgeHandler = (req: Request) => Promise<Response>;

/**
 * In an edge runtime, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * The edge runtime is a generic term for any serverless runtime that supports
 * only standard Web APIs such as `fetch`, `Request`, and `Response`, such as
 * Cloudflare Workers, Vercel Edge Functions, and AWS Lambda@Edge.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/edge";
 * import functions from "~/inngest";
 *
 * export const handler = serve({ id: "my-edge-app", functions });
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (options: ServeHandlerOptions): EdgeHandler => {
  const handler = new InngestCommHandler({
    frameworkName,
    fetch: fetch.bind(globalThis),
    ...options,
    handler: (req: Request) => {
      return {
        body: () => req.json(),
        headers: (key) => req.headers.get(key),
        method: () => req.method,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, { status, headers });
        },
      };
    },
  });

  return handler.createHandler();
};

/**
 * TODO Name
 * TODO Comment
 * TODO Options are rough
 * TODO Flow control etc?
 */
export type WrapHandlerOptions = {
  client: Inngest.Like;
  // TODO
};

/**
 * TODO Name
 * TODO Comment
 */
export const createEndpointWrapper = (options: WrapHandlerOptions) => {
  // Returns a function that wraps an edge handler
  return <T extends (req: Request) => Promise<Response>>(handler: T): T => {
    // When the handler is called, we create a new ALS context
    return (async (req: Request): Promise<Response> => {
      // TODO Right at the top here, is this where we check for a run ID header
      // and then maybe just use `serve()`????

      // We always create a function that represents this endpoint.
      //
      // This is the place we do that as we have access to the request and can
      // be opinionated about how to extract that data.
      const fn = new InngestFunction(
        options.client as Inngest.Any,
        {
          id: "???", // TODO
        },
        () => handler(req),
      );

      const headerRunId = req.headers.get(headerKeys.InngestRunId);
      if (headerRunId) {
        // If we have a run ID, we can just use the normal serve path
        return serve({
          client: options.client,
          functions: [fn],
        })(req);
      }

      // If we're here, this is a regular call to the endpoint and we are not
      // yet running an Inngest execution.
      //
      // We'll put ourselves in an execution so that we can appropriately use
      // step tooling and checkpoint (this means that the `InngestExecution` we
      // use must be set up to checkpoint), though we may never become an
      // Inngest function if no steps are run.

      const als = await getAsyncLocalStorage();
      const ctx = als.getStore();
      if (ctx) {
        throw new Error(
          "We already seem to be in the context of an Inngest execution, but didn't expect to be. Did you already wrap this handler?",
        );
      }

      const newRunId = "make-a-new-one-here";
      const event = {
        name: "http/run.started",
        data: {
          domain: "TODO scheme://host", // scheme + host from OG req
          method: "TODO METHOD", // HTTP method from OG req
          path: "TODO PATH", // Path from OG req
          ip: "TODO IP", // X-Forwarded-For or X-Real-IP
          content_type: "TODO CONTENT TYPE", // parrott header from OG request
          query_params: "TODO QUERY PARAMS", // QueryParams are the query parameters for the request, as a single string without the leading "?".
          body: "TODO BODY", // capture req body by default, allow user to opt out
          fn: "TODO FUNCTION ID", // maybe explicit fn ID from user, else empty
        },
      };

      const result = await fn["createExecution"]({
        version: PREFERRED_EXECUTION_VERSION,
        partialOptions: {
          runId: newRunId,
          client: options.client as Inngest.Any,
          data: {
            event,
            runId: newRunId,
            attempt: 0,
            events: [event],
            maxAttempts: 3, // TODO const default? decided here?
          },
          headers: {}, // TODO traceparent/tracestate only - parrotting back
          reqArgs: [req],
          stepCompletionOrder: [],
          stepState: {},
          disableImmediateExecution: false,
          isFailureHandler: false,
          timer: new ServerTiming(),
        },
      }).start();

      const resultHandlers: ExecutionResultHandlers = {
        "step-not-found": () => {
          throw new Error(
            "We should not get the result 'step-not-found' when checkpointing. This is a bug in the `inngest` SDK",
          );
        },
        "steps-found": () => {
          throw new Error(
            "We should not get the result 'steps-found' when checkpointing. This is a bug in the `inngest` SDK",
          );
        },
        "step-ran": () => {
          throw new Error(
            "We should not get the result 'step-ran' when checkpointing. This is a bug in the `inngest` SDK",
          );
        },
        "function-rejected": ({ error }) => {
          // TODO Should we be rethrowing?
          throw error;
        },
        "function-resolved": ({ data }) => {
          // We're done and we didn't call any step tools, so just return the
          // response.
          return data;
        },
      };
    }) as T;
  };
};
