import {
  type ExtendedTracesMiddlewareOptions,
  extendedTracesMiddleware,
} from "../execution/otel/middleware.ts";
import { metadataMiddleware } from "../InngestMetadata.ts";
import { scoreMiddleware } from "../InngestScore.ts";

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
 * Returns a tuple of the individual middlewares; spread it to combine the
 * bundle with your own. Each is also available on its own; this bundle is
 * equivalent to using `extendedTracesMiddleware({ behaviour: "extendProvider" })`,
 * `metadataMiddleware()`, and `scoreMiddleware()` together.
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
 *   middleware: aiMiddleware(),
 * });
 * ```
 */
export const aiMiddleware = ({
  traces,
}: AiMiddlewareOptions = {}): [
  // The tuple is load-bearing; the client only picks up ctx/step type
  // extensions from a tuple, never from an array.
  ReturnType<typeof extendedTracesMiddleware>,
  ReturnType<typeof metadataMiddleware>,
  ReturnType<typeof scoreMiddleware>,
] => [
  extendedTracesMiddleware(
    traces === false
      ? { behaviour: "off" }
      : { ...traces, behaviour: traces?.behaviour ?? "extendProvider" },
  ),
  metadataMiddleware(),
  scoreMiddleware(),
];
