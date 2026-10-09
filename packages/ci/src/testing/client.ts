/**
 * The Inngest client tests use, wired to the fake sandbox API.
 *
 * @module
 */

import type { InngestFunction } from "inngest";
import { Inngest } from "inngest";
import type { EventBus } from "./eventBus.ts";
import type { FakeSandboxApi } from "./fakeSandbox.ts";

/**
 * Every function a test client has created, so `runFunction` can find the one a
 * `step.invoke` names, as the executor finds it among the app's functions.
 */
export const createdFunctions = new WeakMap<object, InngestFunction.Any[]>();

/**
 * An Inngest client whose sandbox calls hit the fake sandbox API.
 */
export const createCiTestClient = (
  sandboxApi: FakeSandboxApi,
  id = "ci-test",
  bus?: EventBus,
): Inngest.Any => {
  const client = new Inngest({
    id,
    isDev: true,
    eventKey: "test-key",
    // The sandbox client signs its requests, so it needs a key even in dev.
    signingKey: "signkey-test-12345",
    fetch: bus ? busFetch(sandboxApi, bus) : sandboxApi.fetch,
    logger: {
      info: () => {
        return undefined;
      },
      warn: () => {
        return undefined;
      },
      error: () => {
        return undefined;
      },
      debug: () => {
        return undefined;
      },
    },
  });

  const created: InngestFunction.Any[] = [];
  const createFunction = client.createFunction.bind(client);

  createdFunctions.set(client, created);

  // biome-ignore lint/suspicious/noExplicitAny: wrapping an overloaded method
  (client as any).createFunction = (...args: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: wrapping an overloaded method
    const fn = (createFunction as any)(...args);

    created.push(fn);

    return fn;
  };

  return client;
};

/**
 * A fetch that takes the events the client sends onto the bus, as the event API
 * would, and passes everything else to the fake sandbox API.
 */
const busFetch = (sandboxApi: FakeSandboxApi, bus: EventBus): typeof fetch => {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    if (init?.method !== "POST" || !new URL(url).pathname.startsWith("/e/")) {
      return sandboxApi.fetch(input, init);
    }

    const sent = JSON.parse(String(init.body)) as
      | { name: string; data?: Record<string, unknown> }
      | { name: string; data?: Record<string, unknown> }[];

    const events = Array.isArray(sent) ? sent : [sent];

    for (const event of events) {
      bus.send(event);
    }

    return new Response(
      JSON.stringify({
        ids: events.map((_, i) => {
          return `01EVENT${i}`;
        }),
        status: 200,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
};
