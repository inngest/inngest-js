/**
 * An adapter for Nitro to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @module
 */

import type {
  InternalServeHandlerOptions,
  ServeHandlerOptions,
  SyncHandlerOptions,
} from "./components/InngestCommHandler.ts";
import {
  createExperimentalEndpointWrapper as createExperimentalEndpointWrapperH3,
  serve as serveH3,
} from "./h3.ts";
import type { SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "nitro";

/**
 * In Nitro, serve and register any declared functions with Inngest, making them
 * available to be triggered by events.
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ReturnType<typeof serveH3> => {
  const optsOverrides: InternalServeHandlerOptions = {
    ...options,
    frameworkName,
  };

  return serveH3(optsOverrides);
};

/**
 * In Nitro, create a function that can define an event handler with Inngest
 * steps enabled, allowing you to use steps seamlessly within that API.
 *
 * @example
 * ```ts
 * import { Inngest, step } from "inngest";
 * import { createExperimentalEndpointWrapper } from "inngest/nitro";
 *
 * const inngestEventHandler = createExperimentalEndpointWrapper({
 *   client: new Inngest({ id: "nitro-sync-example" }),
 * });
 *
 *
 * export default inngestEventHandler(async (event) => {
 *   const foo = await step.run("example/step", async () => {
 *     return "Hello from step!";
 *   });
 *
 *   return `
 *       <meta charset="utf-8">
 *       <h1>This endpoint worked!</h1>
 *       <p>The step's result was: ${foo}</p>
 *     `;
 * });
 * ```
 */
export const createExperimentalEndpointWrapper = (
  options: SyncHandlerOptions,
) => {
  const optsOverrides = {
    ...options,
    frameworkName,
  };

  return createExperimentalEndpointWrapperH3(optsOverrides);
};
