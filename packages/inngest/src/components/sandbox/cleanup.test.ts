/**
 * @module
 * Tests for the cleanup defer of scoped sandboxes: when it is registered, when
 * it is aborted, and what it destroys.
 */

import { runFnWithStack } from "../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../types.ts";
import { withMiddlewareFunctions } from "../InngestCommHandler.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { createSandboxCleanup } from "./cleanup.ts";
import {
  createClient,
  createScopeClient,
  now,
  sandboxId,
  sandboxResource,
} from "./test-helpers.ts";

const createOptions = { name: "box", vcpu: 2, memoryMb: 2048 };

type Client = ReturnType<typeof createScopeClient>["client"];

/**
 * Run `fn` for at most `requests` requests, memoizing each step, and return
 * the opcodes of the defers it shipped. A run cut off before it finishes is
 * what a cancel or a timeout leaves behind.
 */
const runForRequests = async (fn: InngestFunction.Any, requests: number) => {
  const defers: OutgoingOp[] = [];
  let stepState: Parameters<typeof runFnWithStack>[1] = {};

  for (let request = 0; request < requests; request++) {
    const result = await runFnWithStack(fn, stepState);
    const ops =
      result.type === "step-ran"
        ? [result.step]
        : result.type === "steps-found"
          ? result.steps
          : [];

    for (const op of ops) {
      if (op.op === StepOpCode.DeferAdd || op.op === StepOpCode.DeferAbort) {
        defers.push(op);
      } else if (op.op === StepOpCode.StepRun) {
        stepState = {
          ...stepState,
          [op.id]: { id: op.id, data: op.data },
        };
      }
    }

    if (result.type !== "step-ran" && result.type !== "steps-found") {
      break;
    }
  }

  return defers;
};

const names = (defers: OutgoingOp[]) => {
  return defers.map((op) => `${op.op}:${op.userland?.id}`);
};

const buildScoped = (client: Client) => {
  return client.createFunction(
    { id: "scoped", triggers: [{ event: "sandbox/cleanup" }] },
    async ({ step }) => {
      await using sandbox = await step.sandbox.create("box", createOptions);
      await sandbox.commands.run("run", "echo hi");
    },
  );
};

describe("sandbox cleanup defer", () => {
  test("group.sandbox() registers it before the create step", async () => {
    const { client } = createScopeClient();
    const fn = client.createFunction(
      { id: "grouped", triggers: [{ event: "sandbox/cleanup" }] },
      async ({ group }) => {
        await group.sandbox("box", async () => undefined);
      },
    );

    const defers = await runForRequests(fn, 1);

    expect(names(defers)).toEqual(["DeferAdd:box:cleanup"]);
    expect(defers[0]?.opts).toMatchObject({
      fn_slug: expect.stringContaining("inngest-sandbox-cleanup"),
      input: { name: "run-box" },
    });
  });

  test("await using registers it once the sandbox is declared, by ID", async () => {
    const { client } = createScopeClient();

    const defers = await runForRequests(buildScoped(client), 2);

    expect(names(defers)).toEqual(["DeferAdd:box:cleanup"]);
    expect(defers[0]?.opts?.input).toEqual({
      name: sandboxResource.name,
      sandboxId,
    });
  });

  test("a plain create never registers it, even when the sandbox is used", async () => {
    const { client } = createScopeClient();
    const fn = client.createFunction(
      { id: "plain", triggers: [{ event: "sandbox/cleanup" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.create("box", createOptions);
        await sandbox.commands.run("run", "echo hi");
        await sandbox.destroy("destroy");
      },
    );

    expect(await runForRequests(fn, 10)).toEqual([]);
  });

  test.each([
    { name: "group.sandbox()", requests: 1 },
    { name: "await using", requests: 2 },
  ])(
    "$name run cut off after its create leaves the defer to run",
    async ({ name, requests }) => {
      const { client, calls } = createScopeClient();
      const fn =
        name === "await using"
          ? buildScoped(client)
          : client.createFunction(
              { id: "grouped", triggers: [{ event: "sandbox/cleanup" }] },
              async ({ group }) => {
                await group.sandbox("box", async (sandbox) => {
                  await sandbox.commands.run("run", "echo hi");
                });
              },
            );

      const defers = await runForRequests(fn, requests);

      expect(names(defers)).toEqual(["DeferAdd:box:cleanup"]);
      expect(calls.destroys).toBe(0);
    },
  );

  test.each([
    {
      name: "await using",
      build: buildScoped,
    },
    {
      name: "group.sandbox()",
      build: (client: Client) => {
        return client.createFunction(
          { id: "grouped", triggers: [{ event: "sandbox/cleanup" }] },
          async ({ group }) => {
            await group.sandbox("box", async () => undefined);
          },
        );
      },
    },
  ])("$name aborts it after a successful destroy", async ({ build }) => {
    const { client, calls } = createScopeClient();

    const defers = await runForRequests(build(client), 20);

    expect(calls.destroys).toBe(1);
    expect(names(defers)).toContain("DeferAbort:box:cleanup");
  });

  test("a destroy that fails for good leaves the defer to run", async () => {
    const { client } = createScopeClient(() => {
      return Response.json(
        { errors: [{ code: "forbidden", message: "no access" }] },
        { status: 403 },
      );
    });

    const defers = await runForRequests(buildScoped(client), 20);

    expect(names(defers)).not.toContain("DeferAbort:box:cleanup");
  });
});

describe("sandbox cleanup function", () => {
  const run = async (data: { name: string; sandboxId?: string }) => {
    const calls: string[] = [];
    const client = createClient((path, method) => {
      calls.push(`${method} ${path}`);

      if (path === "/v2/sandboxes" && method === "GET") {
        return Response.json({
          data: [sandboxResource],
          page: { hasMore: false, limit: 100 },
          metadata: { fetchedAt: now },
        });
      }

      if (path === `/v2/sandboxes/${sandboxId}` && method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      return undefined;
    });
    const cleanup = createSandboxCleanup(client);

    const event = {
      name: "inngest/deferred.schedule",
      data: {
        ...data,
        _inngest: { parent_fn_slug: "p", parent_run_id: "r" },
      },
    };
    const result = await runFnWithStack(
      cleanup,
      {},
      { event, events: [structuredClone(event)] },
    );

    return { result, calls };
  };

  test("destroys by ID without listing", async () => {
    const { result, calls } = await run({ name: "box", sandboxId });

    expect(result.type).toBe("step-ran");
    expect(calls).toContain(`DELETE /v2/sandboxes/${sandboxId}`);
    expect(calls).not.toContain("GET /v2/sandboxes");
  });

  test("destroys by name when there is no ID", async () => {
    const { result, calls } = await run({ name: sandboxResource.name });

    expect(result.type).toBe("step-ran");
    expect(calls).toContain("GET /v2/sandboxes");
    expect(calls).toContain(`DELETE /v2/sandboxes/${sandboxId}`);
  });
});

describe("serving the cleanup function", () => {
  test("a client with the sandbox middleware serves it once", () => {
    const { client } = createScopeClient();
    const cleanup = createSandboxCleanup(client);

    for (const served of [[], [cleanup]]) {
      const fns = withMiddlewareFunctions(client, served);

      expect(fns).toEqual([cleanup]);
    }
  });
});
