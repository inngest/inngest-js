/**
 * @module
 * EXPERIMENTAL: the per-client registry of functions that agents need served.
 * `inngest.agent()` and the definitions it references (sandboxes, tools) call
 * `registerFunctions()` when they are declared; `serve()` and `connect()` ask
 * the client's middleware for `functions` and so add the registered ones to the
 * app, deduped by function ID. The middleware that answers is built into every
 * client, because a client's middleware list is fixed when it is constructed.
 */

import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { Middleware } from "../middleware/middleware.ts";

const registries = new WeakMap<Inngest.Any, Map<string, InngestFunction.Any>>();

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Makes `serve()` and `connect()` serve `fns` for this client, in addition to
 * the functions they are given. Idempotent by function ID: registering the
 * same ID again keeps one function, the latest definition, in its original
 * place.
 *
 * @param client The client the functions belong to.
 * @param fns The functions to serve, such as an agent's cleanup function.
 */
export const registerFunctions = (
  client: Inngest.Any,
  fns: readonly InngestFunction.Any[],
): void => {
  let registry = registries.get(client);

  if (!registry) {
    registry = new Map();
    registries.set(client, registry);
  }

  for (const fn of fns) {
    registry.set(fn.id(client.id), fn);
  }
};

/**
 * The functions registered for `client` so far, in registration order.
 *
 * @param client The client to read.
 */
export const registeredFunctions = (
  client: Inngest.Any,
): InngestFunction.Any[] => {
  return [...(registries.get(client)?.values() ?? [])];
};

/**
 * Serves what `registerFunctions()` registered. Built into every client.
 */
export class AgentRegistryMiddleware extends Middleware.BaseMiddleware {
  readonly id = "inngest:agents";

  static override functions({ client }: Middleware.FunctionsArgs) {
    return registeredFunctions(client);
  }
}
