import {
  headerKeys,
  InngestCommHandler,
  queryKeys,
  type ServeHandler,
} from "inngest";

/**
 * An example serve handler to demonstrate how to create a custom serve handler
 * for a framework or runtime of your choice.
 *
 * If you build a handler for your framework, please consider contributing it
 * back to the Inngest project so that others can use it too!
 *
 * @example
 * ```ts
 * import { serve } from "./my-handler";
 * import fns from "~/inngest";
 *
 * export const handler = serve("My App", fns);
 * ```
 *
 * We export a `serve` function that uses the `ServeHandler` type to match the
 * signature of the `serve` function in `inngest`. This function takes a name or
 * Inngest instance, an object of functions, and an options object.
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  /**
   * First we create a new `InngestCommHandler` instance. This instance is
   * responsible for handling the communication between Inngest and your
   * functions, and is typed strictly to ensure you can't miss any
   * functionality.
   */
  const handler = new InngestCommHandler(
    /**
     * The first argument is the name of the framework or runtime you're
     * creating a handler for. This is used to identify your handler in the
     * Inngest dashboard. It's recommended that it's a short, lowercase string
     * that doesn't contain any spaces.
     */
    "edge",

    /**
     * The second argument is the name of our handler or an instance of Inngest.
     * We use the input `nameOrInngest` argument here that's passed by the user.
     */
    nameOrInngest,

    /**
     * The third argument is an object of functions that we want to make
     * available to Inngest. We use the input `fns` argument here that's passed
     * by the user.
     */
    fns,

    /**
     * The fourth argument is an options object. We use the input `opts`
     * argument here that's passed by the user and spread it into the options
     * object. This allows the user to override any of the default options.
     *
     * This is a great place to set any sensible defaults for your handler.
     */
    {
      ...opts,
    },

    /**
     * This function will take a request and return a typed object that Inngest
     * will use to determine what to do with the request.
     *
     * You can see that we manually type the `(req: Request)` argument here.
     * This function will receive whatever arguments your framework passes to an
     * HTTP invocation. In Next.js, for example, this would be a `NextJSRequest`
     * and `NextJSResponse` object. In this edge example, it'll be a regular
     * global `Request` object.
     */
    (req: Request) => {
      /**
       * Next we grab the URL of the endpoint. Function registration isn't
       * always triggered by Inngest, so the SDK needs to be able to self-report
       * its endpoint.
       */
      const url = new URL(req.url, `https://${req.headers.get("host") || ""}`);

      /**
       * This function enforces that we return an object with this shape. We
       * always need a URL, then a function for each action that can be provided
       * by the SDK.
       *
       * These returned functions are used by Inngest to decide what kind of
       * request is incoming, ensuring you can control how the framework's input
       * should be interpreted.
       *
       * We can also specify some overrides:
       *
       * `env` provides environment variables if env vars in this
       * framework/runtime are not available at `process.env`. Inngest needs
       * access to these to be able to find event keys, signing keys, and other
       * important details.
       *
       * `isProduction` is a boolean that tells Inngest whether or not this is a
       * production environment. This is used to determine whether or not to
       * utilise local development functionality such as the SDK's landing page
       * or attempting to contact the development server. By default, we'll try
       * to use environment variables such as `NODE_ENV` to infer this.
       *
       */
      return {
        url,

        /**
         * When wanting to register a function, Inngest will send a `PUT`
         * request to the endpoint. This function should either return
         * `undefined` if it is not a register request, or an object with
         * details required to register the function.
         */
        register: () => {
          if (req.method === "PUT") {
            return {
              /**
               * See what we use the `queryKeys` enum here to access search
               * param variables - make sure to always use these enums to ensure
               * your handler is compatible with future versions of Inngest.
               */
              deployId: url.searchParams.get(queryKeys.DeployId) as string,
            };
          }
        },

        /**
         * When wanting to run a function, Inngest will send a `POST` request
         * to the endpoint. This function should either return `undefined` if
         * it is not a run request, or an object with details required to run
         * the function.
         *
         * There's lots of enum use for accessing the query params and headers
         * here.
         */
        run: async () => {
          if (req.method === "POST") {
            return {
              /**
               * Data is expected to be a parsed JSON object whose values will
               * be validated internally. In this case, `req.json()` returns a
               * `Promise`; any of these methods can be async if needed.
               */
              data: (await req.json()) as Record<string, unknown>,
              fnId: url.searchParams.get(queryKeys.FnId) as string,
              stepId: url.searchParams.get(queryKeys.StepId) as string,
              signature: req.headers.get(headerKeys.Signature) as string,
            };
          }
        },

        /**
         * When wanting to introspect a function or see the SDK landing page in
         * development, Inngest will send a `GET` request to the endpoint. This
         * function should either return `undefined` if it is not an
         * view request, or an object with the details required.
         */
        view: () => {
          if (req.method === "GET") {
            return {
              isIntrospection: url.searchParams.has(queryKeys.Introspect),
            };
          }
        },
      };
    },

    /**
     * Finally, this function will take the internal response from Inngest and
     * transform it into a response that your framework can use.
     *
     * In this case - for an edge handler - we just return a global `Response`
     * object.
     *
     * This function also receives any of the arguments that your framework
     * passes to an HTTP invocation that we specified above. This ensures that
     * you can use calls such as `res.send()` in Express-like frameworks where
     * a particular return isn't required.
     */
    ({ body, status, headers }, _req): Response => {
      return new Response(body, { status, headers });
    }
  );

  /**
   * Finally, we call the `createHandler` method on our `InngestCommHandler`
   * instance to create the serve handler that we'll export.
   */
  return handler.createHandler();
};
