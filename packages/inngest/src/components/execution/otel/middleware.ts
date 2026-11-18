import {
  context,
  type DiagLogger,
  DiagLogLevel,
  diag,
  trace,
} from "@opentelemetry/api";
import Debug from "debug";
import type { OTelSetup } from "../../../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";
import { version } from "../../../version.ts";
import { Middleware } from "../../middleware/middleware.ts";
import {
  behaviourToExtendedTracesBehavior,
  sdkFeatureObservations,
} from "../../sdkFeatureObservations.ts";
import { clientProcessorMap } from "./access.ts";
import { debugPrefix } from "./consts.ts";
import type { InngestSpanProcessor } from "./processor.ts";
import {
  type Behaviour,
  createProvider,
  extendProvider,
  type Instrumentations,
  warnDeprecatedCreateProviderBehaviour,
} from "./util.ts";

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
   * The behaviour of the Extended Traces middleware. This controls whether the
   * middleware will create a new OpenTelemetry provider, extend an existing one, or
   * do nothing. The default is "auto", which will attempt to extend an
   * existing provider, and if that fails, use the deprecated provider creation
   * path.
   *
   * - `"auto"`: Attempt to extend an existing provider, and if that fails,
   *   create a new one using the deprecated provider creation path.
   * - `"createProvider"`: Create a new OpenTelemetry provider.
   *   Deprecated. Use @inngest/otel and
   *   `"extendProvider"` instead.
   * - `"extendProvider"`: Attempt to extend an existing provider.
   * - `"off"`: Do nothing.
   */
  behaviour?: Behaviour;

  /**
   * Add additional instrumentations to the OpenTelemetry provider.
   *
   * Note that these only apply when the middleware uses the deprecated provider
   * creation path. Extending an existing provider cannot add instrumentations;
   * configure them wherever the provider is created instead.
   *
   * @deprecated Configure custom instrumentations wherever your OpenTelemetry
   * provider is created. This option only applies to the deprecated provider
   * creation path in `extendedTracesMiddleware`.
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
  devDebug("behaviour:", behaviour);

  let processor: InngestSpanProcessor | undefined;
  let processorReady: Promise<void> | undefined;
  let setup: OTelSetup | undefined;
  const configuredBehavior = behaviourToExtendedTracesBehavior(behaviour);

  function replaceExtendedTracesObservation(
    client: Middleware.OnRegisterArgs["client"],
  ): void {
    sdkFeatureObservations.extendedTraces.replace(client, {
      behavior: configuredBehavior,
      setup,
    });
  }

  function setProcessorReady(pending: Promise<void>): void {
    processorReady = pending.finally(() => {
      processorReady = undefined;
    });
  }

  switch (behaviour) {
    case "auto": {
      const extended = extendProvider(behaviour);
      if (extended.success) {
        devDebug("extended existing provider");
        processor = extended.processor;
        setup = extended.setup;
        break;
      }

      setup = extended.setup;
      warnDeprecatedCreateProviderBehaviour(behaviour);
      setProcessorReady(
        createProvider(behaviour, instrumentations).then((created) => {
          setup = created.setup;
          if (created.success) {
            devDebug("created new provider");
            processor = created.processor;
          } else {
            console.warn(
              "no provider found to extend and unable to create one",
              created.error ?? "",
            );
          }
        }),
      );

      break;
    }
    case "createProvider": {
      warnDeprecatedCreateProviderBehaviour(behaviour);
      setProcessorReady(
        createProvider(behaviour, instrumentations).then((created) => {
          setup = created.setup;
          if (created.success) {
            devDebug("created new provider");
            processor = created.processor;
          } else {
            console.warn(
              "unable to create provider, Extended Traces middleware will not work",
              created.error ?? "",
            );
          }
        }),
      );

      break;
    }
    case "extendProvider": {
      const extended = extendProvider(behaviour);
      if (extended.success) {
        devDebug("extended existing provider");
        processor = extended.processor;
        setup = extended.setup;
        break;
      }

      setup = extended.setup;
      console.warn(
        "unable to extend provider, Extended Traces middleware will not work. Use @inngest/otel, or make sure that the provider is created and imported before the middleware is used.",
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
    readonly id = "inngest:extended-traces";

    /**
     * Called by the Inngest constructor to associate the processor with the
     * client.
     */
    static override onRegister({ client }: Middleware.OnRegisterArgs) {
      replaceExtendedTracesObservation(client);

      // Set the logger for our otel processors and exporters.
      // If this is called multiple times, only the first call is set.
      devDebug(
        "set otel diagLogger:",
        diag.setLogger(new InngestTracesLogger(), logLevel),
      );

      if (processor) {
        clientProcessorMap.set(client, processor);
      } else if (processorReady) {
        // Legacy provider creation is async, so this client may report the
        // current sync snapshot before setup completes. Keep execution wiring
        // updated once the processor is available.
        processorReady
          .then(() => {
            replaceExtendedTracesObservation(client);
            if (processor) {
              clientProcessorMap.set(client, processor);
            }
          })
          .catch((err) => {
            devDebug("failed to register processor for client:", err);
          });
      }
    }

    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      const step = arg.ctx.step;
      const run = step.run;

      // Preserve the OpenTelemetry async-context that is active when
      // `step.run()` is called so that it is still active inside the step's
      // callback when it executes. Steps run asynchronously via the execution
      // engine, so by the time the callback runs the caller's `context.with()`
      // scope (e.g. Langfuse's `propagateAttributes`) has already ended; this
      // captures the context at declaration time and restores it on execution.
      // See #1436
      const stepWithPreservedContext = {
        ...step,
        run: ((
          idOrOptions: Parameters<typeof run>[0],
          fn: Parameters<typeof run>[1],
          ...input: Parameters<typeof run>[2]
        ) => {
          const outerContext = context.active();

          const preserveContext = (...args: Parameters<typeof fn>) =>
            context.with(outerContext, () => fn(...args));

          return run(idOrOptions, preserveContext as typeof fn, ...input);
        }) as typeof run,
      } as typeof step;

      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          tracer: trace.getTracer("inngest", version),
          step: stepWithPreservedContext,
        },
      };
    }

    override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
      return next().finally(() => processor?.forceFlush());
    }
  }

  return ExtendedTracesMiddleware;
};
