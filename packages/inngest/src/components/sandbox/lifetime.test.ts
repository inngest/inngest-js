/**
 * @module
 * Tests for how the durable sandbox ends: destroying a sandbox that is
 * already gone, and `await using` scopes.
 */

import { runFnWithStack, runSteps } from "../../test/helpers.ts";
import { _internals } from "../execution/engine.ts";
import {
  createClient,
  createScopeClient,
  ranStep,
  runToEnd,
  sandboxId,
} from "./test-helpers.ts";

const createOptions = { name: "box", vcpu: 2, memoryMb: 2048 };

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

describe("await using a sandbox", () => {
  type Client = ReturnType<typeof createScopeClient>["client"];

  test.each([
    {
      name: "a scope",
      expected: ["box", "run", "box:destroy"],
      build: (client: Client) => {
        return client.createFunction(
          { id: "sandbox-scope", triggers: [{ event: "sandbox/using" }] },
          async ({ step }) => {
            await using sandbox = await step.sandbox.create(
              "box",
              createOptions,
            );
            await sandbox.commands.run("run", "echo hi");
          },
        );
      },
    },
    {
      name: "a block, then carries on",
      expected: ["box", "run", "box:destroy", "after"],
      build: (client: Client) => {
        return client.createFunction(
          { id: "sandbox-block", triggers: [{ event: "sandbox/using" }] },
          async ({ step }) => {
            {
              await using sandbox = await step.sandbox.create(
                "box",
                createOptions,
              );
              await sandbox.commands.run("run", "echo hi");
            }

            await step.run("after", () => "done");
          },
        );
      },
    },
  ])(
    "destroys at the end of $name, once across replays",
    async ({ build, expected }) => {
      const { client, calls } = createScopeClient();

      const { type, ran } = await runToEnd(build(client));

      expect(type).toBe("function-resolved");
      expect(ran).toEqual(expected);
      expect(calls.destroys).toBe(1);
    },
  );

  test("does not destroy when the request is interrupted by new steps", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "sandbox-interrupted", triggers: [{ event: "sandbox/using" }] },
      async ({ step }) => {
        await using sandbox = await step.sandbox.create("box", createOptions);
        await Promise.all([
          sandbox.commands.run("a", "echo a"),
          sandbox.commands.run("b", "echo b"),
        ]);
      },
    );

    const [box] = await runSteps(fn, 1);
    const result = await runFnWithStack(fn, {
      [box!.id]: { id: box!.id, data: box!.data },
    });

    expect(result.type).toBe("steps-found");
    expect(calls.destroys).toBe(0);
  });

  test("treats a sandbox that is already gone as destroyed", async () => {
    const { client } = createScopeClient(notFound);
    const fn = client.createFunction(
      { id: "sandbox-gone", triggers: [{ event: "sandbox/using" }] },
      async ({ step }) => {
        await using _sandbox = await step.sandbox.create("box", createOptions);
      },
    );

    expect(await runToEnd(fn)).toMatchObject({
      type: "function-resolved",
      ran: ["box", "box:destroy"],
    });
  });

  test("destroys, then rethrows, when the scope throws", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "sandbox-throws", triggers: [{ event: "sandbox/using" }] },
      async ({ step }) => {
        await using _sandbox = await step.sandbox.create("box", createOptions);
        throw new Error("boom");
      },
    );

    expect(await runToEnd(fn, { attempt: 0, maxAttempts: 5 })).toMatchObject({
      type: "function-rejected",
      ran: ["box", "box:destroy"],
      retriable: false,
    });
    expect(calls.destroys).toBe(1);
  });

  test("retries a later step that fails after the scope ended", async () => {
    const { client } = createScopeClient();
    const fn = client.createFunction(
      { id: "sandbox-later-step", triggers: [{ event: "sandbox/using" }] },
      async ({ step }) => {
        {
          await using _sandbox = await step.sandbox.create(
            "box",
            createOptions,
          );
        }

        await step.run("after", () => {
          throw new Error("temporary");
        });
      },
    );

    const [box] = await runSteps(fn, 1);
    const stepState = { [box!.id]: { id: box!.id, data: box!.data } };
    const destroy = ranStep(await runFnWithStack(fn, stepState));
    const result = await runFnWithStack(
      fn,
      { ...stepState, [destroy!.id]: { id: destroy!.id, data: destroy!.data } },
      { attempt: 0, maxAttempts: 5 },
    );

    expect(ranStep(result)?.op).toBe("StepError");
  });

  test("leaves an error thrown with no scope retriable", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "sandbox-no-scope", triggers: [{ event: "sandbox/using" }] },
      async ({ step }) => {
        await step.sandbox.create("box", createOptions);
        throw new Error("boom");
      },
    );

    expect(await runToEnd(fn, { attempt: 0, maxAttempts: 5 })).toMatchObject({
      type: "function-rejected",
      ran: ["box"],
      retriable: true,
    });
    expect(calls.destroys).toBe(0);
  });
});

describe("await using a sandbox that can't be destroyed", () => {
  const forbidden = () => {
    return Response.json(
      { errors: [{ code: "forbidden", message: "no access" }] },
      { status: 403 },
    );
  };

  const unavailable = () => {
    return Response.json(
      { errors: [{ code: "unavailable", message: "try later" }] },
      { status: 503 },
    );
  };

  test.each([
    {
      name: "the scope succeeds",
      body: async () => {},
      type: "function-resolved",
    },
    {
      name: "the scope throws a retryable error",
      body: async () => {
        throw new Error("boom");
      },
      type: "function-rejected",
    },
  ])(
    "swallows a permanent destroy failure when $name",
    async ({ body, type }) => {
      const { client, calls } = createScopeClient(forbidden);
      const fn = client.createFunction(
        { id: "sandbox-undestroyable", triggers: [{ event: "sandbox/using" }] },
        async ({ step }) => {
          await using _sandbox = await step.sandbox.create(
            "box",
            createOptions,
          );
          await body();
        },
      );

      const first = ranStep(await runFnWithStack(fn, {}));
      const box = { id: first!.id, data: first!.data };

      const destroy = ranStep(await runFnWithStack(fn, { [box.id]: box }));
      assert(destroy);
      expect(destroy.metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "inngest.warning.sdk.sandbox.destroy",
            values: {
              "sdk.sandbox.destroy": expect.stringContaining(
                `Sandbox ${sandboxId} couldn't be destroyed: `,
              ),
            },
          }),
        ]),
      );

      const failed = {
        id: destroy.id,
        error: destroy.error,
      };

      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await runFnWithStack(
          fn,
          { [box.id]: box, [failed.id]: failed },
          { priorDefers: { [_internals.hashId("box:cleanup")]: {} } },
        );

        expect(result.type).toBe(type);
        if (result.type === "function-rejected") {
          expect(result.error).toMatchObject({ message: "boom" });
        }
      }

      expect(calls.destroys).toBe(1);
    },
  );

  test("retries a transient destroy failure within the step", async () => {
    let failures = 1;
    const { client, calls } = createScopeClient(() => {
      return failures-- > 0
        ? unavailable()
        : new Response(null, { status: 204 });
    });
    const fn = client.createFunction(
      { id: "sandbox-transient", triggers: [{ event: "sandbox/using" }] },
      async ({ step }) => {
        await using _sandbox = await step.sandbox.create("box", createOptions);
      },
    );

    const [box] = await runSteps(fn, 1);
    const stepState = { [box!.id]: { id: box!.id, data: box!.data } };

    const retried = ranStep(await runFnWithStack(fn, stepState));
    expect(retried?.op).toBe("StepError");

    const destroyed = ranStep(await runFnWithStack(fn, stepState));
    assert(destroyed);
    expect(destroyed.error).toBeUndefined();
    expect(calls.destroys).toBe(2);
  });
});
