/**
 * The Inngest client tests use, wired to the fake sandbox API.
 *
 * @module
 */

import { Inngest } from "inngest";
import type { FakeSandboxApi } from "./fakeSandbox.ts";

/**
 * An Inngest client whose sandbox calls hit the fake sandbox API.
 */
export const createCiTestClient = (
  sandboxApi: FakeSandboxApi,
  id = "ci-test",
): Inngest.Any => {
  return new Inngest({
    id,
    isDev: true,
    eventKey: "test-key",
    // The sandbox client signs its requests, so it needs a key even in dev.
    signingKey: "signkey-test-12345",
    fetch: sandboxApi.fetch,
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
};
