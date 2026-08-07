import {
  type ExtendedTracesMiddlewareOptions,
  extendedTracesMiddleware,
} from "../execution/otel/middleware.ts";
import type { Inngest } from "../Inngest.ts";
import { metadataMiddleware } from "../InngestMetadata.ts";
import { scoreMiddleware } from "../InngestScore.ts";
import { Middleware } from "../middleware/middleware.ts";

type TransformedInput<TMiddleware> = TMiddleware extends {
  transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): infer TReturn;
}
  ? TReturn
  : never;

/**
 * A set of options for the AI middleware bundle.
 */
export interface AiMiddlewareOptions {
  /**
   * Options passed to the bundled Extended Traces middleware, or `false` to
   * disable extended traces.
   *
   * Defaults to `{ behaviour: "extendProvider" }`.
   */
  traces?: false | ExtendedTracesMiddlewareOptions;
}

/**
 * Middleware that enables all experimental AI features in one place:
 * scoring (`step.score()`), metadata (`step.metadata()`, `inngest.metadata`),
 * and extended traces (`ctx.tracer`).
 *
 * Each feature's middleware is also available individually; this bundle is
 * equivalent to using `scoreMiddleware()`, `metadataMiddleware()`, and
 * `extendedTracesMiddleware({ behaviour: "extendProvider" })` together.
 *
 * Extended traces attach to your app's existing OpenTelemetry provider. If
 * you don't already have one, install `@inngest/otel` and load it before any
 * app code (e.g. `node --import @inngest/otel/node ./app.js`, or
 * `NODE_OPTIONS="--import @inngest/otel/node"` when a framework CLI owns the
 * node process), or pass `traces: false` to opt out. See
 * https://www.inngest.com/docs/examples/open-telemetry.
 *
 * @example
 * ```ts
 * import { aiMiddleware } from "inngest/experimental";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   middleware: [aiMiddleware()],
 * });
 * ```
 */
export const aiMiddleware = ({ traces }: AiMiddlewareOptions = {}) => {
  const ScoreMiddleware = scoreMiddleware();
  const MetadataMiddleware = metadataMiddleware();
  const ExtendedTracesMiddleware = extendedTracesMiddleware(
    traces === false
      ? { behaviour: "off" }
      : { ...traces, behaviour: traces?.behaviour ?? "extendProvider" },
  );

  class AiMiddleware extends Middleware.BaseMiddleware {
    readonly id = "inngest:ai";

    readonly #score: InstanceType<typeof ScoreMiddleware>;
    readonly #metadata: InstanceType<typeof MetadataMiddleware>;
    readonly #traces: InstanceType<typeof ExtendedTracesMiddleware>;

    constructor(args: { client: Inngest.Any }) {
      super(args);
      this.#score = new ScoreMiddleware(args);
      this.#metadata = new MetadataMiddleware(args);
      this.#traces = new ExtendedTracesMiddleware(args);
    }

    static override onRegister(args: Middleware.OnRegisterArgs) {
      ScoreMiddleware.onRegister(args);
      MetadataMiddleware.onRegister(args);
      ExtendedTracesMiddleware.onRegister(args);
    }

    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ): TransformedInput<InstanceType<typeof ExtendedTracesMiddleware>> &
      TransformedInput<InstanceType<typeof MetadataMiddleware>> &
      TransformedInput<InstanceType<typeof ScoreMiddleware>> {
      const withTraces = this.#traces.transformFunctionInput(arg);
      const withMetadata = this.#metadata.transformFunctionInput(withTraces);
      const withScore = this.#score.transformFunctionInput(withMetadata);

      // `withScore` is complete at runtime, but each middleware's declared
      // return type only advertises its own extension, so re-add the two the
      // static type dropped.
      return {
        ...withScore,
        ctx: {
          ...withScore.ctx,
          tracer: withTraces.ctx.tracer,
          step: {
            ...withScore.ctx.step,
            metadata: withMetadata.ctx.step.metadata,
          },
        },
      };
    }

    override wrapRequest(args: Middleware.WrapRequestArgs) {
      return this.#traces.wrapRequest(args);
    }
  }

  return AiMiddleware;
};
