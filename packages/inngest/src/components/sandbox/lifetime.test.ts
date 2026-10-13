/**
 * @module
 * Tests for how the durable sandbox ends: destroying a sandbox that is
 * already gone, and `await using` scopes.
 */

import { runFnWithStack, runSteps } from "../../test/helpers.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { createClient, sandboxId, sandboxResource } from "./test-helpers.ts";

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

/**
 * A client whose sandbox API creates, execs in and destroys sandboxes, with
 * the number of destroys it has served.
 */
const createScopeClient = (
  destroy: () => Response = () => new Response(null, { status: 204 }),
) => {
  const calls = { destroys: 0 };

  const client = createClient((path, method) => {
    if (path === "/v2/sandboxes" && method === "POST") {
      return Response.json({ data: sandboxResource }, { status: 201 });
    }

    if (path.endsWith("/exec")) {
      return Response.json({
        data: { stdout: "", stderr: "", encoding: "base64", exitCode: 0 },
      });
    }

    if (path === `/v2/sandboxes/${sandboxId}` && method === "DELETE") {
      calls.destroys++;

      return destroy();
    }

    return undefined;
  });

  return { client, calls };
};

/**
 * Run `fn` request by request until it finishes, memoizing each step, and
 * return how it finished and the IDs of the steps that ran.
 */
const runToEnd = async (fn: InngestFunction.Any) => {
  const ran: string[] = [];
  let stepState: Parameters<typeof runFnWithStack>[1] = {};

  for (let request = 0; request < 20; request++) {
    const result = await runFnWithStack(fn, stepState);

    if (result.type !== "step-ran") {
      return { type: result.type, ran };
    }

    const { id, data, error } = result.step;
    ran.push(result.step.userland?.id ?? id);
    stepState = { ...stepState, [id]: { id, data, error } };
  }

  throw new Error("The function did not finish");
};

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

    expect(await runToEnd(fn)).toEqual({
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

    expect(await runToEnd(fn)).toEqual({
      type: "function-rejected",
      ran: ["box", "box:destroy"],
    });
    expect(calls.destroys).toBe(1);
  });
});
