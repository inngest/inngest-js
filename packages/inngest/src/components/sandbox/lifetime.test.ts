/**
 * @module
 * Tests for how the durable sandbox ends: destroying a sandbox that is
 * already gone, and `await using` scopes.
 */

import { runSteps } from "../../test/helpers.ts";
import { createClient, sandboxId } from "./test-helpers.ts";

const notFound = () => {
  return Response.json(
    { errors: [{ code: "sandbox_not_found", message: "gone" }] },
    { status: 404 },
  );
};

describe("sandbox destroy", () => {
  test.each([
    {
      name: "a destroyed sandbox",
      response: () => new Response(null, { status: 204 }),
    },
    { name: "a sandbox that is already gone", response: notFound },
  ])("terminates $name", async ({ response }) => {
    const client = createClient((path, method) => {
      if (path === `/v2/sandboxes/${sandboxId}` && method === "DELETE") {
        return response();
      }

      return undefined;
    });

    const fn = client.createFunction(
      { id: "sandbox-destroy", triggers: [{ event: "sandbox/destroy" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.get("get-box", sandboxId);

        return sandbox?.destroy("destroy");
      },
    );

    const [, destroy] = await runSteps(fn, 2);

    expect(destroy?.error).toBeUndefined();
    expect(destroy?.data).toMatchObject({
      result: { status: "TERMINATED", sandbox: null },
    });
  });
});
