import { diag, DiagLogLevel, trace, type DiagLogger } from "@opentelemetry/api";
import Debug from "debug";
import { version } from "../../../version.js";
import { InngestMiddleware } from "../../InngestMiddleware.js";
import { clientProcessorMap } from "./access.js";
import { debugPrefix } from "./consts.js";
import { type InngestSpanProcessor } from "./processor.js";
import {
  createProvider,
  extendProvider,
  type Behaviour,
  type Instrumentations,
} from "./util.js";

const debug = Debug(`${debugPrefix}:middleware`);

class InngestOtelDiagLogger implements DiagLogger {
  #logger = Debug(`${debugPrefix}:diag`);

  debug = this.#logger;
  error = this.#logger;
  info = this.#logger;
  verbose = this.#logger;
  warn = this.#logger;
}

/**
 * A set of options for the OTel middleware.
 */
export interface OTelMiddlewareOptions {
  /**
   * The behaviour of the OTel middleware. This controls whether the
   * middleware will create a new OTel provider, extend an existing one, or
   * do nothing. The default is "auto", which will attempt to extend an
   * existing provider, and if that fails, create a new one.
   *
   * - `"auto"`: Attempt to extend an existing provider, and if that fails,
   *   create a new one.
   * - `"createProvider"`: Create a new OTel provider.
   * - `"extendProvider"`: Attempt to extend an existing provider.
   * - `"off"`: Do nothing.
   */
  behaviour?: Behaviour;

  /**
   * Add additional instrumentations to the OTel provider.
   *
   * Note that these only apply if the provider is created by the middleware;
   * extending an existing provider cannot add instrumentations and it instead
   * must be done wherever the provider is created.
   */
  instrumentations?: Instrumentations;

  /**
   * The log level for the OTel middleware, specifially a diagnostic logger
   * attached to the global OTel provider.
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
export const otelMiddleware = ({
  behaviour = "auto",
  instrumentations,
  logLevel = DiagLogLevel.ERROR,
}: OTelMiddlewareOptions = {}) => {
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

      console.warn("unable to create provider, OTel middleware will not work");

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
        'unable to extend provider, OTel middleware will not work. Either allow the middleware to create a provider by setting `behaviour: "createProvider"` or `behaviour: "auto"`, or make sure that the provider is created and imported before the middleware is used.'
      );

      break;
    }
    case "off": {
      break;
    }
    default: {
      // unknown
      console.warn(
        `unknown behaviour ${JSON.stringify(behaviour)}, defaulting to "off"`
      );
    }
  }

  return new InngestMiddleware({
    name: "Inngest: OTel",
    init({ client }) {
      // Set the logger for our otel processors and exporters.
      // If this is called multiple times (for example by the user in some other
      // custom code), then only the first call is set, so we don't have to
      // worry about overwriting it here accidentally.
      //
      debug(
        "set otel diagLogger:",
        diag.setLogger(new InngestOtelDiagLogger(), logLevel)
      );

      if (processor) {
        clientProcessorMap.set(client, processor);
      }

      return {
        onFunctionRun() {
          return {
            transformInput() {
              return {
                ctx: {
                  /**
                   * A tracer that can be used to create spans within a step
                   * that will be displayed on the Inngest dashboard (or Dev
                   * Server).
                   *
                   * Note that creating spans outside of steps when the function
                   * contains `step.*()` calls is not currently supported.
                   */
                  tracer: trace.getTracer("inngest", version),
                },
              };
            },

            async beforeResponse() {
              // Should this be awaited? And is it fine to flush after every
              // execution?
              await processor?.forceFlush();
            },
          };
        },
      };
    },
  });
};
