import { trace } from "@opentelemetry/api";
import Debug from "debug";
import { version } from "../../../version.js";
import { InngestMiddleware } from "../../InngestMiddleware.js";
import { clientProcessorMap } from "./access.js";
import { type InngestSpanProcessor } from "./processor.js";
import {
  type Behaviour,
  createProvider,
  extendProvider,
  type Instrumentations,
} from "./util.js";

const debug = Debug("inngest:otel:middleware");

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
}

/**
 * TODO
 */
// TODO Ugh need an onClose hook to shutdown lol
export const otelMiddleware = ({
  behaviour = "auto",
  instrumentations,
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
          };
        },
      };
    },
  });
};
