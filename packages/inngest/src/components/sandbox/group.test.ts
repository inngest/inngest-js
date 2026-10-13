/**
 * @module
 * Tests for `group.sandbox()`.
 */

import { NonRetriableError } from "../NonRetriableError.ts";
import { createScopeClient, runToEnd } from "./test-helpers.ts";

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

  test.each([
    {
      name: "an unknown error with retries remaining",
      attempt: 0,
      fail: () => Promise.reject(new Error("boom")),
      destroys: 0,
    },
    {
      name: "an unknown error on the last attempt",
      attempt: 4,
      fail: () => Promise.reject(new Error("boom")),
      destroys: 1,
    },
    {
      name: "a non-retriable error",
      attempt: 0,
      fail: () => Promise.reject(new NonRetriableError("boom")),
      destroys: 1,
    },
  ])(
    "on $name, destroys $destroys time",
    async ({ attempt, fail, destroys }) => {
      const { client, calls } = createScopeClient();

      const { type } = await runToEnd(buildFailing(client, fail), {
        attempt,
        maxAttempts: 5,
      });

      expect(type).toBe("function-rejected");
      expect(calls.destroys).toBe(destroys);
    },
  );

  test("destroys when a step in the callback fails for good", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "group-step-fails", triggers: [{ event: "group/sandbox" }] },
      async ({ group, step }) => {
        await group.sandbox("box", async () => {
          await step.run("fail", () => {
            throw new NonRetriableError("boom");
          });
        });
      },
    );

    const { ran } = await runToEnd(fn, { attempt: 0, maxAttempts: 5 });

    expect(ran).toEqual(["box", "fail", "box:destroy"]);
    expect(calls.destroys).toBe(1);
  });
});
