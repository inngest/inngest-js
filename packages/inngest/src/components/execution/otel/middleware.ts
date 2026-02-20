import { type DiagLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import Debug from "debug";
import type { Logger } from "../../../middleware/logger.ts";
import { version } from "../../../version.ts";
import { Middleware } from "../../middleware/middleware.ts";
import { clientProcessorMap } from "./access.ts";
import { debugPrefix } from "./consts.ts";
import type { InngestSpanProcessor } from "./processor.ts";
import {
  type Behaviour,
  createProvider,
  extendProvider,
  type Instrumentations,
} from "./util.ts";

const debug = Debug(`${debugPrefix}:middleware`);

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
   * The behaviour of the Extended Traces middleware. This controls whether the
   * middleware will create a new OpenTelemetry provider, extend an existing one, or
   * do nothing. The default is "auto", which will attempt to extend an
   * existing provider, and if that fails, create a new one.
   *
   * - `"auto"`: Attempt to extend an existing provider, and if that fails,
   *   create a new one.
   * - `"createProvider"`: Create a new OpenTelemetry provider.
   * - `"extendProvider"`: Attempt to extend an existing provider.
   * - `"off"`: Do nothing.
   */
  behaviour?: Behaviour;

  /**
   * Add additional instrumentations to the OpenTelemetry provider.
   *
   * Note that these only apply if the provider is created by the middleware;
   * extending an existing provider cannot add instrumentations and it instead
   * must be done wherever the provider is created.
   */
  instrumentations?: Instrumentations;

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
  behaviour = "auto",
  instrumentations,
  logLevel = DiagLogLevel.ERROR,
}: ExtendedTracesMiddlewareOptions = {}) => {
  debug("behaviour:", behaviour);

  let processor: InngestSpanProcessor | undefined;

  switch (behaviour) {
    case "auto": {
      const extended = extendProvider(behaviour);
      if (extended.success) {
        debug("extended existing provider");
        processor = extended.processor;
        break;
      }

      const created = createProvider(behaviour, instrumentations);
      if (created.success) {
        debug("created new provider");
        processor = created.processor;
        break;
      }

      console.warn("no provider found to extend and unable to create one");

      break;
    }
    case "createProvider": {
      const created = createProvider(behaviour, instrumentations);
      if (created.success) {
        debug("created new provider");
        processor = created.processor;
        break;
      }

      console.warn(
        "unable to create provider, Extended Traces middleware will not work",
      );

      break;
    }
    case "extendProvider": {
      const extended = extendProvider(behaviour);
      if (extended.success) {
        debug("extended existing provider");
        processor = extended.processor;
        break;
      }

      console.warn(
        'unable to extend provider, Extended Traces middleware will not work. Either allow the middleware to create a provider by setting `behaviour: "createProvider"` or `behaviour: "auto"`, or make sure that the provider is created and imported before the middleware is used.',
      );

      break;
    }
    case "off": {
      break;
    }
    default: {
      // unknown
      console.warn(
        `unknown behaviour ${JSON.stringify(behaviour)}, defaulting to "off"`,
      );
    }
  }

  class ExtendedTracesMiddleware extends Middleware.BaseMiddleware {
    /**
     * Called by the Inngest constructor to associate the processor with the
     * client.
     */
    static override onRegister({ client }: Middleware.OnRegisterArgs) {
      // Set the logger for our otel processors and exporters.
      // If this is called multiple times, only the first call is set.
      debug(
        "set otel diagLogger:",
        diag.setLogger(new InngestTracesLogger(), logLevel),
      );

      if (processor) {
        clientProcessorMap.set(client, processor);
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

    override wrapRequest({ next }: Middleware.WrapRequestArgs) {
      return next().finally(() => processor?.forceFlush());
    }
  }

  return ExtendedTracesMiddleware;
};
