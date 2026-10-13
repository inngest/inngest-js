/**
 * @module
 * Fakes shared by the sandbox tests: a sandbox reference and an `Inngest`
 * client whose sandbox REST API is served by a callback.
 */

import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { sandboxMiddleware } from "./middleware.ts";

export const sandboxId = "22222222-2222-4222-8222-222222222222";
export const now = "2026-07-28T00:00:00Z";

export const sandboxRef = {
  kind: "inngest/sandbox" as const,
  version: 1 as const,
  id: sandboxId,
  name: "ci-box",
  status: "RUNNING" as const,
  vpcId: "11111111-1111-4111-8111-111111111111",
  imageRef: "default",
  resources: { vcpu: 2, memoryMb: 2048 },
  createdAt: now,
  startedAt: now,
};

const { kind: _kind, version: _version, ...resource } = sandboxRef;

/**
 * The sandbox as the REST API returns it.
 */
export const sandboxResource = resource;

/**
 * A client whose sandbox API returns `sandboxRef` for a `get`, answers other
 * paths with `route`, and 404s the rest.
 */
export const createClient = (
  route: (path: string, method: string) => Response | undefined,
) => {
  return new Inngest({
    id: testClientId,
    signingKey: "signkey-test",
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      const { pathname } = new URL(
        input instanceof Request ? input.url : input,
      );

      if (
        pathname === `/v2/sandboxes/${sandboxId}` &&
        (init?.method ?? "GET") === "GET"
      ) {
        return Response.json({ data: sandboxResource });
      }

      return (
        route(pathname, init?.method ?? "GET") ??
        Response.json(
          { errors: [{ code: "missing", message: "missing" }] },
          { status: 404 },
        )
      );
    },
    middleware: [sandboxMiddleware()],
  });
};
