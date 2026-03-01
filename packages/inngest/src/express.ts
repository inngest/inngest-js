/**
 * An adapter for Express to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/express";
 * import { inngest } from "./src/inngest/client";
 * import fnA from "./src/inngest/fnA"; // Your own function
 *
 * // Important:  ensure you add JSON middleware to process incoming JSON POST payloads.
 * app.use(express.json());
 * app.use(
 *   // Expose the middleware on our recommended path at `/api/inngest`.
 *   "/api/inngest",
 *   serve({ client: inngest, functions: [fnA] })
 * );
 * ```
 *
 * @module
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Request, Response } from "express";
import type { Inngest } from "./components/Inngest.ts";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
  type SyncHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { handleDurableEndpointProxyRequest } from "./components/InngestDurableEndpointProxy.ts";
import { InngestEndpointAdapter } from "./components/InngestEndpointAdapter.ts";
import type { Either } from "./helpers/types.ts";
import type { RegisterOptions, SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "express";

// biome-ignore lint/suspicious/noExplicitAny: intentional to avoid type portability issues
export type ExpressHandler = (...args: any[]) => any;

const commHandler = (
  options: RegisterOptions & { client: Inngest.Like },
  syncOptions?: SyncHandlerOptions,
) => {
  return new InngestCommHandler({
    frameworkName,
    ...options,
    syncOptions,
    handler: (
      req: Either<VercelRequest, Request>,
      res: Either<Response, VercelResponse>,
    ) => {
      return {
        body: () => req.body,
        headers: (key) => {
          const header = req.headers[key];
          return Array.isArray(header) ? header[0] : header;
        },
        method: () => req.method || "GET",
        url: () => {
          // `req.hostname` can filter out port numbers; beware!
          const hostname = req.headers["host"] || options?.serveHost;

          const protocol = hostname?.includes("://")
            ? ""
            : `${req.protocol || "https"}://`;

          const url = new URL(
            req.originalUrl || req.url || "",
            `${protocol}${hostname || ""}`,
          );

          return url;
        },
        queryString: (key) => {
          const qs = req.query[key];
          return Array.isArray(qs) ? qs[0] : qs;
        },
        transformResponse: ({ body, headers, status }) => {
          for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value);
          }

          return res.status(status).send(body);
        },

        /**
         * Express doesn't support a Web API `ReadableStream` being written as
         * the response body (only `node:stream` `ReadableStream`s), so we
         * manually read the stream we're given and call `res.write()` for each
         * chunk.
         *
         * See {@link https://github.com/expressjs/discussions/issues/288}.
         *
         * Alternatively, we could pipe this through a transform and create a
         * Node stream, but the feels more dangerous than just writing directly
         * to the response.
         */
        transformStreamingResponse: async ({ body, headers, status }) => {
          for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value);
          }

          res.status(status);

          const reader = body.getReader();
          try {
            // Keep writing from the stream until it's done
            let done = false;
            while (!done) {
              const result = await reader.read();
              done = result.done;
              if (!done) {
                res.write(result.value);
              }
            }
            res.end();
          } catch (error) {
            if (error instanceof Error) {
              res.destroy(error);
            } else {
              res.destroy(new Error(String(error)));
            }
          }
        },

        experimentalTransformSyncResponse: async (data) => {
          const expressRes = data as Response;
          const headers: Record<string, string> = {};

          const rawHeaders = expressRes.getHeaders?.() || {};
          for (const [k, v] of Object.entries(rawHeaders)) {
            if (typeof v === "string") {
              headers[k] = v;
            } else if (Array.isArray(v)) {
              headers[k] = v.join(", ");
            }
          }

          return {
            headers,
            status: expressRes.statusCode || 200,
            body: "",
          };
        },
      };
    },
  });
};

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * The return type is currently `any` to ensure there's no required type matches
 * between the `express` and `vercel` packages. This may change in the future to
 * appropriately infer.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/express";
 * import { inngest } from "./src/inngest/client";
 * import fnA from "./src/inngest/fnA"; // Your own function
 *
 * // Important:  ensure you add JSON middleware to process incoming JSON POST payloads.
 * app.use(express.json());
 * app.use(
 *   // Expose the middleware on our recommended path at `/api/inngest`.
 *   "/api/inngest",
 *   serve({ client: inngest, functions: [fnA] })
 * );
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
// biome-ignore lint/suspicious/noExplicitAny: intentional
export const serve = (options: ServeHandlerOptions): any => {
  return commHandler(options).createHandler();
};

/**
 * Creates a durable endpoint proxy handler for Express environments.
 */
const createDurableEndpointProxyHandler = (
  options: InngestEndpointAdapter.ProxyHandlerOptions,
): ExpressHandler => {
  return async (
    req: Either<VercelRequest, Request>,
    res: Either<Response, VercelResponse>,
  ): Promise<void> => {
    const runId = req.query?.runId;
    const token = req.query?.token;

    const result = await handleDurableEndpointProxyRequest(
      options.client as Inngest.Any,
      {
        runId: Array.isArray(runId)
          ? (runId[0] ?? null)
          : (runId?.toString() ?? null),
        token: Array.isArray(token)
          ? (token[0] ?? null)
          : (token?.toString() ?? null),
        method: req.method || "GET",
      },
    );

    for (const [name, value] of Object.entries(result.headers)) {
      res.setHeader(name, value);
    }

    res.status(result.status).send(result.body);
  };
};

/**
 * In Express, create a function that can wrap any endpoint to be able to use
 * steps seamlessly within that API.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { Inngest, step } from "inngest";
 * import { endpointAdapter } from "inngest/express";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   endpointAdapter,
 * });
 *
 * const app = express();
 * app.use(express.json());
 *
 * app.get("/api/durable", inngest.endpoint(async (req, res) => {
 *   const foo = await step.run("my-step", () => ({ foo: "bar" }));
 *   res.json({ result: foo });
 * }));
 * ```
 */
export const endpointAdapter: InngestEndpointAdapter.Like & {
  createProxyHandler: (
    options: InngestEndpointAdapter.ProxyHandlerOptions,
  ) => ExpressHandler;
} = InngestEndpointAdapter.create((options) => {
  return commHandler(options, options).createSyncHandler();
}, createDurableEndpointProxyHandler);
