import { diag, DiagLogLevel, trace, type DiagLogger } from "@opentelemetry/api";
import Debug from "debug";
import { version } from "../../../version.js";
import { InngestMiddleware } from "../../InngestMiddleware.js";
import { clientProcessorMap } from "./access.js";
import { type InngestSpanProcessor } from "./processor.js";
import {
  createProvider,
  extendProvider,
  type Behaviour,
  type Instrumentations,
} from "./util.js";

const debug = Debug("inngest:otel:middleware");

class InngestOtelDiagLogger implements DiagLogger {
  #logger = Debug("inngest:otel:diag");

  debug = this.#logger;
  error = this.#logger;
  info = this.#logger;
  verbose = this.#logger;
  warn = this.#logger;
}

/**
 * TODO
 */
export interface OTelMiddlewareOptions {
  /**
   * TODO
   */
  behaviour?: Behaviour;

  /**
   * TODO
   */
  instrumentations?: Instrumentations;

  /**
   * TODO
   */
  logLevel?: DiagLogLevel;
}

/**
 * TODO
 */
// TODO Ugh need an onClose hook to shutdown lol
export const otelMiddleware = ({
  behaviour = "auto",
  instrumentations,
  logLevel = DiagLogLevel.VERBOSE, // TODO make the default ERROR
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
                   * TODO
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
