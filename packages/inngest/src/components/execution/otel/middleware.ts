import { type DiagLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import Debug from "debug";
import { version } from "../../../version.ts";
import { Middleware } from "../../middleware/middleware.ts";
import { registerClientProcessor } from "./access.ts";
import { debugPrefix } from "./consts.ts";
import type { InngestSpanProcessor } from "./processor.ts";
import { extendProvider } from "./util.ts";

const devDebug = Debug(`${debugPrefix}:middleware`);

class InngestTracesLogger implements DiagLogger {
  #logger = Debug(`${debugPrefix}:diag`);

  debug = this.#logger;
  error = this.#logger;
  info = this.#logger;
  verbose = this.#logger;
  warn = this.#logger;
}

/**
 * A set of options for the Extended Traces middleware.
 */
export interface ExtendedTracesMiddlewareOptions {
  /**
   * The log level for the Extended Traces middleware, specifically a diagnostic logger
   * attached to the global OpenTelemetry provider.
   *
   * Defaults to `DiagLogLevel.ERROR`.
   */
  logLevel?: DiagLogLevel;
}

/**
 * Middleware the captures and exports spans relevant to Inngest runs using
 * OTel.
 *
 * This can be used to attach additional spans and data to the existing traces
 * in your Inngest dashboard (or Dev Server).
 */
export const extendedTracesMiddleware = ({
  logLevel = DiagLogLevel.ERROR,
}: ExtendedTracesMiddlewareOptions = {}) => {
  let processor: InngestSpanProcessor | undefined;

  const extended = extendProvider();
  if (extended.success) {
    devDebug("extended existing provider");
    processor = extended.processor;
  }

  class ExtendedTracesMiddleware extends Middleware.BaseMiddleware {
    readonly id = "inngest:extended-traces";

    /**
     * Called by the Inngest constructor to associate the processor with the
     * client.
     */
    static override onRegister({ client }: Middleware.OnRegisterArgs) {
      // Set the logger for our otel processors and exporters.
      // If this is called multiple times, only the first call is set.
      devDebug(
        "set otel diagLogger:",
        diag.setLogger(new InngestTracesLogger(), logLevel),
      );

      if (processor) {
        registerClientProcessor(client, processor);
      }
    }

    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          tracer: trace.getTracer("inngest", version),
        },
      };
    }

    override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
      return next().finally(() => processor?.forceFlush());
    }
  }

  return ExtendedTracesMiddleware;
};
