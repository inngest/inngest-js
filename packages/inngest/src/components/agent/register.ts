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

const internalLogger = Symbol.for("inngest.internalLogger");

/**
 * The IDs `serve()` or `connect()` have served for a client so far.
 */
const served = new WeakMap<Inngest.Any, Set<string>>();

/**
 * Records that `serve()` or `connect()` served functions with these IDs, so
 * later registrations of other IDs can be reported.
 *
 * @param client The client that was served.
 * @param ids The fully qualified function IDs served.
 */
export const markServed = (
  client: Inngest.Any,
  ids: Iterable<string>,
): void => {
  const known = served.get(client) ?? new Set<string>();

  for (const id of ids) {
    known.add(id);
  }

  served.set(client, known);
};

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
 * `serve()` and `connect()` read the registry once, when they are called, so
 * register before them: declare agents in modules the serving module imports.
 * A function registered after that is logged as a warning, once per ID.
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

  const known = served.get(client);
  const late: string[] = [];

  for (const fn of fns) {
    const id = fn.id(client.id);

    if (known && !known.has(id)) {
      late.push(id);
      known.add(id);
    }

    registry.set(id, fn);
  }

  if (late.length > 0) {
    (
      client as unknown as Record<
        symbol,
        { warn: (...args: unknown[]) => void }
      >
    )[internalLogger]?.warn(
      { functionIds: late },
      "Functions were registered after serve() or connect() read this client's functions, so they are not served. Declare agents in modules the serving module imports.",
    );
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
