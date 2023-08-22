import {
  type FastifyPluginCallback,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { type Inngest } from "./components/Inngest";
import {
  InngestCommHandler,
  type ServeHandler,
} from "./components/InngestCommHandler";
import { type InngestFunction } from "./components/InngestFunction";
import { headerKeys, queryKeys } from "./helpers/consts";
import { type RegisterOptions, type SupportedFrameworkName } from "./types";

export const name: SupportedFrameworkName = "fastify";

type QueryString = {
  [key in queryKeys]: string;
};

type Headers = {
  [key in headerKeys]: string;
};

type InngestPluginOptions = {
  client: Inngest<any>;
  functions: InngestFunction<any, any, any, any>[];
  options?: RegisterOptions;
};

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    name,
    nameOrInngest,
    fns,
    opts,
    (
      req: FastifyRequest<{ Querystring: QueryString; Headers: Headers }>,
      _reply: FastifyReply
    ) => {
      const hostname = req.headers["host"];
      const protocol = hostname?.includes("://") ? "" : `${req.protocol}://`;
      const url = new URL(req.url, `${protocol}${hostname || ""}`);

      return {
        url,
        run: () => {
          if (req.method === "POST") {
            return {
              fnId: req.query[queryKeys.FnId] as string,
              stepId: req.query[queryKeys.StepId] as string,
              data: req.body as Record<string, unknown>,
              signature: req.headers[headerKeys.Signature] as string,
            };
          }
        },
        register: () => {
          if (req.method === "PUT") {
            return {
              deployId: req.query[queryKeys.DeployId]?.toString(),
            };
          }
        },
        view: () => {
          if (req.method === "GET") {
            return {
              isIntrospection: Object.hasOwnProperty.call(
                req.query,
                queryKeys.Introspect
              ),
            };
          }
        },
      };
    },
    (actionRes, _req, reply) => {
      for (const [name, value] of Object.entries(actionRes.headers)) {
        reply.header(name, value);
      }
      reply.code(actionRes.status);
      return reply.send(actionRes.body);
    }
  );

  return handler.createHandler();
};

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * @public
 */
const fastifyPlugin = ((fastify, options, done) => {
  try {
    const handler = serve(options.client, options.functions, options.options);

    fastify.route({
      method: ["GET", "POST", "PUT"],
      handler,
      url: options.options?.serveHost || "/api/inngest",
    });

    done();
  } catch (err) {
    done(err as Error);
  }
}) satisfies FastifyPluginCallback<InngestPluginOptions>;

export default fastifyPlugin;
