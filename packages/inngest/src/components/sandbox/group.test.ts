/**
 * @module
 * Tests for `group.sandbox()`.
 */

import { NonRetriableError } from "../NonRetriableError.ts";
import { createScopeClient, runToEnd, sandboxId } from "./test-helpers.ts";

type Client = ReturnType<typeof createScopeClient>["client"];

const group = { id: "box", name: "Sandbox box", kind: "sandbox" };

const buildFailing = (client: Client, fail: () => Promise<never>) => {
  return client.createFunction(
    { id: "group-fails", triggers: [{ event: "group/sandbox" }] },
    async ({ group }) => {
      await group.sandbox("box", async (sandbox) => {
        await sandbox.commands.run("run", "echo hi");

        return fail();
      });
    },
  );
};

describe("group.sandbox", () => {
  test("creates, runs and destroys inside one sandbox group", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "group-sandbox", triggers: [{ event: "group/sandbox" }] },
      async ({ group, step }) => {
        const result = await group.sandbox("box", async (sandbox) => {
          await sandbox.commands.run("run", "echo hi");

          return "result";
        });

        await step.run("after", () => result);
      },
    );

    const { type, ran, steps } = await runToEnd(fn);

    expect(type).toBe("function-resolved");
    expect(ran).toEqual(["box", "run", "box:destroy", "after"]);
    expect(calls.destroys).toBe(1);
    expect(steps.map((step) => step.opts?.span)).toEqual([
      [group],
      [group],
      [group],
      undefined,
    ]);
  });

  test.each([
    {
      name: "an ID",
      idOrOptions: "box",
      expected: { name: "run-box", vcpu: 2, memoryMb: 2048 },
    },
    {
      name: "create options",
      idOrOptions: { id: "box", name: "mine", vcpu: 1, memoryMb: 1024 },
      expected: { name: "mine", vcpu: 1, memoryMb: 1024 },
    },
  ])("takes $name", async ({ idOrOptions, expected }) => {
    const { client } = createScopeClient();
    const fn = client.createFunction(
      { id: "group-forms", triggers: [{ event: "group/sandbox" }] },
      async ({ group }) => {
        await group.sandbox(idOrOptions, async () => undefined);
      },
    );

    const { ran, steps } = await runToEnd(fn);

    expect(ran).toEqual(["box", "box:destroy"]);
    expect(steps[0]?.opts?.input).toMatchObject([
      { action: "create", input: [expected] },
    ]);
  });

  test("destroys and throws a non-retriable error with the cause for a plain error", async () => {
    const { client, calls } = createScopeClient();
    const cause = new Error("boom");

    const { type, error, ran } = await runToEnd(
      buildFailing(client, () => Promise.reject(cause)),
    );

    expect(type).toBe("function-rejected");
    expect(ran).toEqual(["box", "run", "box:destroy"]);
    expect(calls.destroys).toBe(1);
    expect(error).toMatchObject({
      name: "NonRetriableError",
      message: "boom",
      cause: { message: "boom" },
    });
  });

  test("rethrows a non-retriable error unchanged", async () => {
    const { client, calls } = createScopeClient();

    const { error } = await runToEnd(
      buildFailing(client, () => Promise.reject(new NonRetriableError("boom"))),
    );

    expect(calls.destroys).toBe(1);
    expect(error).toMatchObject({ name: "NonRetriableError", message: "boom" });
    expect(error).toHaveProperty("cause", undefined);
  });

  test("rethrows a step error unchanged and destroys", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      {
        id: "group-step-fails",
        retries: 0,
        triggers: [{ event: "group/sandbox" }],
      },
      async ({ group, step }) => {
        await group.sandbox("box", async () => {
          await step.run("fail", () => {
            throw new Error("boom");
          });
        });
      },
    );

    const { ran, error } = await runToEnd(fn);

    expect(ran).toEqual(["box", "fail", "box:destroy"]);
    expect(calls.destroys).toBe(1);
    expect(error).toMatchObject({ name: "Error", message: "boom" });
  });

  test.each([
    {
      name: "returns the callback's result",
      callback: async () => {
        return "result";
      },
      type: "function-resolved",
    },
    {
      name: "rethrows the callback's error",
      callback: async () => {
        throw new Error("boom");
      },
      type: "function-rejected",
    },
  ])("$name when the destroy fails permanently", async ({ callback, type }) => {
    const { client } = createScopeClient(() => {
      return Response.json(
        { errors: [{ code: "forbidden", message: "no access" }] },
        { status: 403 },
      );
    });
    const fn = client.createFunction(
      { id: "group-undestroyable", triggers: [{ event: "group/sandbox" }] },
      async ({ group }) => {
        return group.sandbox("box", callback);
      },
    );

    const result = await runToEnd(fn);
    const destroy = result.steps.find((step) => {
      return step.userland?.id === "box:destroy";
    });

    expect(result.type).toBe(type);
    expect(destroy?.metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "inngest.warnings",
          values: {
            "sdk.sandbox.destroy": expect.stringContaining(
              `Sandbox ${sandboxId} couldn't be destroyed: `,
            ),
          },
        }),
      ]),
    );
  });
});
