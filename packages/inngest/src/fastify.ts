import {
  type FastifyPluginCallback,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { type Inngest } from "./components/Inngest";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { type InngestFunction } from "./components/InngestFunction";
import { type RegisterOptions, type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "fastify";

type InngestPluginOptions = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: Inngest<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  functions: InngestFunction<any, any, any, any>[];
  options?: RegisterOptions;
};

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (
      req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>,
      reply: FastifyReply
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
      };
    },
  });

  return handler.createHandler();
};

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * @public
 */
const fastifyPlugin = ((fastify, options, done) => {
  if (!options?.client) {
    throw new Error(
      "Inngest `client` is required when serving with Fastify plugin"
    );
  }

  if (!options?.functions) {
    throw new Error(
      "Inngest `functions` are required when serving with Fastify plugin"
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
