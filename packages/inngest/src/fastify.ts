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
              fnId: req.query[queryKeys.FnId],
              stepId: req.query[queryKeys.StepId],
              data: req.body as Record<string, unknown>,
              signature: req.headers[headerKeys.Signature],
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
        void reply.header(name, value);
      }
      void reply.code(actionRes.status);
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const handler = serve(options.client, options.functions, options.options);

    fastify.route({
      method: ["GET", "POST", "PUT"],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      handler,
      url: options.options?.servePath || "/api/inngest",
    });

    done();
  } catch (err) {
    done(err as Error);
  }
}) satisfies FastifyPluginCallback<InngestPluginOptions>;

export default fastifyPlugin;
