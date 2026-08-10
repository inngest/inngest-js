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
   * Options passed to the bundled Extended Traces middleware.
   *
   * Mirrors `ExtendedTracesMiddlewareOptions` minus the deprecated
   * provider-creation path, which this bundle never takes: `instrumentations`
   * is only read when creating a provider, and `behaviour` drops `"auto"` and
   * `"createProvider"`.
   *
   * `behaviour: "off"` stops Inngest attaching its span processor to your
   * OpenTelemetry provider. `ctx.tracer` is there either way; with `"off"` its
   * spans reach your own provider but not Inngest.
   *
   * Defaults to `{ behaviour: "extendProvider" }`.
   */
  traces?: Omit<
    ExtendedTracesMiddlewareOptions,
    "behaviour" | "instrumentations"
  > & {
    behaviour?: "extendProvider" | "off";
  };
}

/**
 * Middleware that enables all experimental AI features in one place:
 * scoring (`step.score()`), metadata (`step.metadata()`, `inngest.metadata`),
 * and extended traces (`ctx.tracer`).
 *
 * Returns a tuple of the three middlewares; spread it to combine the bundle
 * with your own. Using the bundle is equivalent to passing
 * `extendedTracesMiddleware({ behaviour: "extendProvider" })`,
 * `metadataMiddleware()`, and `scoreMiddleware()` yourself.
 *
 * Extended traces attach to your app's existing OpenTelemetry provider. If
 * you don't already have one, install `@inngest/otel` and load it before any
 * app code (e.g. `node --import @inngest/otel/node ./app.js`, or
 * `NODE_OPTIONS="--import @inngest/otel/node"` when a framework CLI owns the
 * node process), or pass `traces: { behaviour: "off" }` to stop Inngest
 * attaching to your provider. See
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
  // The client only picks up ctx/step type extensions from a tuple, never from
  // an array, so this annotation is load-bearing.
  ReturnType<typeof extendedTracesMiddleware>,
  ReturnType<typeof metadataMiddleware>,
  ReturnType<typeof scoreMiddleware>,
] => [
  extendedTracesMiddleware({
    ...traces,
    behaviour: traces?.behaviour ?? "extendProvider",
  }),
  metadataMiddleware(),
  scoreMiddleware(),
];
