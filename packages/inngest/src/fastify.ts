/**
 * An adapter for Fastify to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example Plugin (recommended)
 * ```ts
 * import Fastify from "fastify";
 * import inngestFastify from "inngest/fastify";
 * import { inngest, fnA } from "./inngest";
 *
 * const fastify = Fastify();
 *
 * fastify.register(inngestFastify, {
 *   client: inngest,
 *   functions: [fnA],
 *   options: {},
 * });
 *
 * fastify.listen({ port: 3000 }, function (err, address) {
 *   if (err) {
 *     fastify.log.error(err);
 *     process.exit(1);
 *   }
 * });
 * ```
 *
 * @example Route
 * ```ts
 * import Fastify from "fastify";
 * import { serve } from "inngest/fastify";
 * import { fnA, inngest } from "./inngest";
 *
 * const fastify = Fastify();
 *
 * fastify.route({
 *   method: ["GET", "POST", "PUT"],
 *   handler: serve({ client: inngest, functions: [fnA] }),
 *   url: "/api/inngest",
 * });
 *
 * fastify.listen({ port: 3000 }, function (err, address) {
 *   if (err) {
 *     fastify.log.error(err);
 *     process.exit(1);
 *   }
 * });
 * ```
 *
 * @module
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { Inngest } from "./components/Inngest.ts";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import type { InngestFunction } from "./components/InngestFunction.ts";
import type { RegisterOptions, SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "fastify";

type InngestPluginOptions = {
  client: Inngest.Like;
  functions: InngestFunction.Like[];
  options?: RegisterOptions;
};

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * It's recommended to use the Fastify plugin to serve your functions with
 * Inngest instead of using this `serve()` function directly.
 *
 * @example
 * ```ts
 * import Fastify from "fastify";
 * import { serve } from "inngest/fastify";
 * import { fnA, inngest } from "./inngest";
 *
 * const fastify = Fastify();
 *
 * fastify.route({
 *   method: ["GET", "POST", "PUT"],
 *   handler: serve({ client: inngest, functions: [fnA] }),
 *   url: "/api/inngest",
 * });
 *
 * fastify.listen({ port: 3000 }, function (err, address) {
 *   if (err) {
 *     fastify.log.error(err);
 *     process.exit(1);
 *   }
 * });
 * ```
 *
 * @public
 */
export const serve = (
  options: ServeHandlerOptions,
): ((
  req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>,
  reply: FastifyReply,
) => Promise<unknown>) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (
      req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>,
      reply: FastifyReply,
    ) => {
      return {
        body: () => req.body,
        headers: (key) => {
          const header = req.headers[key];
          return Array.isArray(header) ? header[0] : header;
        },
        method: () => req.method,
        url: () => {
          const hostname = req.headers["host"];
          const protocol = hostname?.includes("://")
            ? ""
            : `${req.protocol}://`;

          const url = new URL(req.url, `${protocol}${hostname || ""}`);

          return url;
        },
        queryString: (key) => req.query[key],
        transformResponse: ({ body, status, headers }) => {
          for (const [name, value] of Object.entries(headers)) {
            void reply.header(name, value);
          }
          void reply.code(status);
          return reply.send(body);
        },
        badNameApi: null,
      };
    },
  });

  return handler.createHandler();
};

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * @example
 * ```ts
 * import Fastify from "fastify";
 * import inngestFastify from "inngest/fastify";
 * import { inngest, fnA } from "./inngest";
 *
 * const fastify = Fastify();
 *
 * fastify.register(inngestFastify, {
 *   client: inngest,
 *   functions: [fnA],
 *   options: {},
 * });
 *
 * fastify.listen({ port: 3000 }, function (err, address) {
 *   if (err) {
 *     fastify.log.error(err);
 *     process.exit(1);
 *   }
 * });
 * ```
 *
 * @public
 */
export const fastifyPlugin: (
  fastify: FastifyInstance,
  options: InngestPluginOptions,
  done: (err?: Error | undefined) => void,
) => void = ((fastify, options, done): void => {
  if (!options?.client) {
    throw new Error(
      "Inngest `client` is required when serving with Fastify plugin",
    );
  }

  if (!options?.functions) {
    throw new Error(
      "Inngest `functions` are required when serving with Fastify plugin",
    );
  }

  try {
    const handler = serve({
      client: options?.client,
      functions: options?.functions,
      ...options?.options,
    });

    fastify.route({
      method: ["GET", "POST", "PUT"],
      handler,
      url: options?.options?.servePath || "/api/inngest",
    });

    done();
  } catch (err) {
    done(err as Error);
  }
}) satisfies FastifyPluginCallback<InngestPluginOptions>;

export default fastifyPlugin;
