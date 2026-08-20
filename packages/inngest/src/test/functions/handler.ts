import { InngestCommHandler, type ServeHandlerOptions } from "inngest";

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
 * import { client, functions } from "~/inngest";
 *
 * export const handler = serve({ client, functions });
 * ```
 *
 * We export a `serve` function that uses the `ServeHandler` type to match the
 * signature of the `serve` function in `inngest`. This function takes a name or
 * Inngest instance, an object of functions, and an options object.
 */
export const serve = (options: ServeHandlerOptions) => {
  /**
   * First we create a new `InngestCommHandler` instance. This instance is
   * responsible for handling the communication between Inngest and your
   * functions, and is typed strictly to ensure you can't miss any
   * functionality.
   */
  const handler = new InngestCommHandler({
    /**
     * A `frameworkName` is needed, which is the name of the framework or
     * runtime you're creating a handler for. This is used to identify your
     * handler in the Inngest dashboard. It's recommended that it's a short,
     * lowercase string that doesn't contain any spaces.
     */
    frameworkName: "edge",

    /**
     * Next, we'll spread the user's input options into here. This allows the
     * user to override any options that we set by default.
     */
    ...options,

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
    handler: (req: Request) => {
      /**
       * The function must return an object that tells the Inngest SDK how
       * to access different parts of the request, as well as how to
       * transform an Inngest response into a response that your framework
       * can use.
       *
       * All returned functions can be synchronous or asynchronous.
       */
      return {
        body: () => req.json(),
        headers: (key) => req.headers.get(key),
        method: () => req.method,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),

        /**
         * This function tells the handler how a response from the Inngest
         * SDK should be transformed into a response that your framework can
         * use.
         *
         * If you'd like the handler to be able to support streaming, you
         * can also add a `transformStreamingResponse` function with the
         * same format.
         */
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, { status, headers });
        },

        /**
         * Not all options are provided; some will maintain sensible
         * defaults if not provided. We'll show the approximate defaults
         * below.
         */
        // env: () => process.env,
        // queryString: (key, url) => url.searchParams.get(key),
      };
    },
  });

  /**
   * Finally, we call the `createHandler` method on our `InngestCommHandler`
   * instance to create the serve handler that we'll export.
   *
   * This takes the inferred types from your `handler` above to ensure that the
   * handler given to the user is typed correctly for their framework.
   */
  return handler.createHandler();
};
