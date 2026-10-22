/**
 * @module
 * Tests for `step.sandbox.lazy()`: nothing is created until the first use,
 * uses that start together share one creation, and replays follow the same
 * steps.
 */

import { runFnWithStack, runSteps } from "../../test/helpers.ts";
import { createScopeClient, runToEnd } from "./test-helpers.ts";

const createOptions = { name: "box", vcpu: 2, memoryMb: 2048 };

describe("step.sandbox.lazy", () => {
  test("creates nothing when it is never used", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "lazy-unused", triggers: [{ event: "lazy/run" }] },
      async ({ step }) => {
        await using sandbox = step.sandbox.lazy("box", createOptions);

        sandbox.tools.code();
      },
    );

    expect(await runToEnd(fn)).toMatchObject({
      type: "function-resolved",
      ran: [],
    });
    expect(calls).toMatchObject({ creates: 0, destroys: 0 });
  });

  test("creates on the first command, then reuses the sandbox, and destroys at the end", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "lazy-used", triggers: [{ event: "lazy/run" }] },
      async ({ step }) => {
        await using sandbox = step.sandbox.lazy("box", createOptions);

        await sandbox.commands.run("one", "echo 1");
        await sandbox.commands.run("two", "echo 2");
      },
    );

    expect(await runToEnd(fn)).toMatchObject({
      type: "function-resolved",
      ran: ["box", "one", "two", "box:destroy"],
    });
    expect(calls).toMatchObject({ creates: 1, destroys: 1 });
  });

  test("shares one creation between uses that start together", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "lazy-parallel", triggers: [{ event: "lazy/run" }] },
      async ({ step }) => {
        const sandbox = step.sandbox.lazy("box", createOptions);

        await Promise.all([
          sandbox.commands.run("a", "echo a"),
          sandbox.commands.run("b", "echo b"),
          sandbox.files.write("c", { path: "/x", data: "x" }),
        ]);
      },
    );

    const [box] = await runSteps(fn, 1);
    const next = await runFnWithStack(fn, {
      [box!.id]: { id: box!.id, data: box!.data },
    });

    expect(box?.userland?.id).toBe("box");
    expect(next.type).toBe("steps-found");
    expect(
      (next as { steps: { userland?: { id: string } }[] }).steps.map((op) => {
        return op.userland?.id;
      }),
    ).toEqual(["a", "b", "c"]);
    expect(calls.creates).toBe(1);
  });

  test("gives a model the code tools, which create it on first use", async () => {
    const { client, calls } = createScopeClient();
    const fn = client.createFunction(
      { id: "lazy-tools", triggers: [{ event: "lazy/run" }] },
      async ({ step }) => {
        const sandbox = step.sandbox.lazy("box", createOptions);
        const tools = sandbox.tools.code({ only: ["run"] });

        return (tools.run.run as (input: unknown) => unknown)({
          command: "echo hi",
        });
      },
    );

    expect(await runToEnd(fn)).toMatchObject({
      type: "function-resolved",
      ran: ["box", "run"],
    });
    expect(calls.creates).toBe(1);
  });

  test("replays the same steps every time", async () => {
    const { client } = createScopeClient();
    const fn = client.createFunction(
      { id: "lazy-replay", triggers: [{ event: "lazy/run" }] },
      async ({ step }) => {
        await using sandbox = step.sandbox.lazy("box", createOptions);

        await sandbox.commands.run("one", "echo 1");
      },
    );

    const first = await runToEnd(fn);
    const second = await runToEnd(fn);

    expect(second.ran).toEqual(first.ran);
    expect(first.ran).toEqual(["box", "one", "box:destroy"]);
  });
});
