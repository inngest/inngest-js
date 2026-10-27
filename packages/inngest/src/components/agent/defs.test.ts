/**
 * @module
 * Tests for `tool()` and `sandbox()` definitions and the lazy sandbox handles
 * `openSandboxes()` makes from them.
 */
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import * as z from "zod/v4";
import { tool } from "../sandbox/tools.ts";
import type { DurableSandbox, DurableSandboxTools } from "../sandbox/types.ts";
import { agentTools, openSandboxes, sandbox, sandboxTools } from "./defs.ts";

const fakeEnvironment = () => {
  const runs: string[] = [];
  const destroyed: string[] = [];
  const created = vi.fn(async (_id: unknown, _options: unknown) => {
    return {
      commands: {
        run: async (_id: unknown, command: unknown) => {
          runs.push(String(command));

          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      },
      files: {},
      destroy: async (id: unknown) => {
        destroyed.push(String(id));
      },
    } as unknown as DurableSandbox;
  });

  return {
    runs,
    destroyed,
    created,
    sandboxes: { create: created } as unknown as DurableSandboxTools,
  };
};

describe("tool()", () => {
  test("defines an agent tool and keeps step and group", () => {
    const getOrg = tool({
      id: "getOrg",
      input: z.object({ slug: z.string() }),
      sandboxCommand: "get-org",
      run: async ({ slug }) => {
        return { slug };
      },
    });

    expect(getOrg.kind).toBe("inngest/tool");
    expect(getOrg.id).toBe("getOrg");
    expect(getOrg.sandboxCommand).toBe("get-org");
    expect(tool.step({ run: () => 1 }).group).toBeUndefined();
    expect(tool.group({ run: () => 1 }).group).toBe(true);
  });

  test("infers the input of run", () => {
    tool({
      id: "typed",
      input: z.object({ n: z.number() }),
      run: ({ n }) => {
        expectTypeOf(n).toBeNumber();

        return n;
      },
    });
  });

  test("rejects names the model cannot use", () => {
    expect(() => {
      return tool({ id: "git.push", run: () => 1 });
    }).toThrow("Invalid tool name");
    expect(() => {
      return tool({ id: "ok", sandboxCommand: "Bad_Name", run: () => 1 });
    }).toThrow("Invalid sandboxCommand");
  });

  test("agentTools keys by id and rejects duplicates", () => {
    const a = tool({ id: "a", run: () => 1 });
    const b = tool({ id: "b", run: () => 2 });

    expect(Object.keys(agentTools([a, b]))).toEqual(["a", "b"]);
    expect(() => {
      return agentTools([a, a]);
    }).toThrow('Two tools are named "a"');
  });
});

describe("sandbox()", () => {
  test("is plain data and creates nothing", () => {
    const workbench = sandbox({ id: "workbench", tools: sandbox.tools.code() });

    expect(workbench.kind).toBe("inngest/sandbox.definition");
    expect(Object.isFrozen(workbench)).toBe(true);
  });

  test("rejects a bad id", () => {
    expect(() => {
      return sandbox({ id: "no spaces" });
    }).toThrow("Invalid sandbox id");
  });
});

describe("openSandboxes()", () => {
  const workbench = sandbox({
    id: "workbench",
    image: sandbox.image.custom("py:v1"),
    tools: sandbox.tools.code({ only: ["run", "read"] }),
  });

  test("is lazy by default: nothing is created until a tool runs", async () => {
    const env = fakeEnvironment();
    const opened = openSandboxes({ work: workbench }, env.sandboxes);

    expect(Object.keys(sandboxTools(opened))).toEqual([
      "work_run",
      "work_read",
    ]);
    expect(opened.work?.start).toBe("lazy");
    expect(opened.work?.keepAlive).toBeUndefined();
    expect(env.created).not.toHaveBeenCalled();
    expect(opened.work?.started).toBe(false);

    await opened.work?.close();
    expect(env.created).not.toHaveBeenCalled();
    expect(env.destroyed).toEqual([]);
  });

  test("the first tool call creates one sandbox with the definition's image", async () => {
    const env = fakeEnvironment();
    const opened = openSandboxes({ work: workbench }, env.sandboxes);
    const run = sandboxTools(opened).work_run as unknown as {
      run: (input: { command: string }, ctx: unknown) => Promise<unknown>;
    };

    await Promise.all([
      run.run({ command: "echo 1" }, {}),
      run.run({ command: "echo 2" }, {}),
    ]);

    expect(env.created).toHaveBeenCalledTimes(1);
    expect(env.created.mock.calls[0]?.[0]).toBe("work");
    expect(env.created.mock.calls[0]?.[1]).not.toHaveProperty("id");
    expect(env.created.mock.calls[0]?.[1]).toMatchObject({
      from: { ref: "py:v1" },
    });
    expect(env.runs).toHaveLength(2);
    expect(opened.work?.started).toBe(true);

    await opened.work?.close();
    expect(env.destroyed).toEqual(["work:destroy"]);
  });

  test("eager starts creating at once", async () => {
    const env = fakeEnvironment();
    const opened = openSandboxes(
      {
        data: {
          sandbox: workbench,
          start: "eager",
          keepAlive: { idle: "10m" },
        },
      },
      env.sandboxes,
    );

    expect(env.created).toHaveBeenCalledTimes(1);
    expect(opened.data?.keepAlive).toEqual({ idle: "10m" });

    await opened.data?.get();
    expect(env.created).toHaveBeenCalledTimes(1);
  });

  test("an eager failure surfaces on get, not as an unhandled rejection", async () => {
    const opened = openSandboxes(
      { data: { sandbox: workbench, start: "eager" } },
      {
        create: async () => {
          throw new Error("no capacity");
        },
      } as unknown as DurableSandboxTools,
    );

    await expect(opened.data?.get()).rejects.toThrow("no capacity");
  });
});

describe("validation", () => {
  const def = sandbox({ id: "w", tools: sandbox.tools.code() });
  const { sandboxes } = fakeEnvironment();

  test("rejects a bad binding name, a keepAlive without idle, colliding tool names", () => {
    expect(() => {
      return openSandboxes({ "my-box": def }, sandboxes);
    }).toThrow("Invalid sandbox name");
    expect(() => {
      return openSandboxes(
        { a: { sandbox: def, keepAlive: {} as { idle: string } } },
        sandboxes,
      );
    }).toThrow("needs an idle time");

    const a = sandbox({
      id: "a",
      tools: () => ({ b_c: tool.step({ run: () => 1 }) }),
    });
    const b = sandbox({
      id: "b",
      tools: () => ({ c: tool.step({ run: () => 1 }) }),
    });

    expect(() => {
      return sandboxTools(openSandboxes({ a, a_b: b }, sandboxes));
    }).toThrow("Two sandbox tools");
  });

  test("close after a failed create does not throw", async () => {
    const opened = openSandboxes({ w: def }, {
      create: async () => {
        throw new Error("boom");
      },
    } as unknown as DurableSandboxTools);

    await expect(opened.w?.get()).rejects.toThrow("boom");
    await expect(opened.w?.close()).resolves.toBeUndefined();
  });
});

describe("step ids", () => {
  test("a definition's tool steps are prefixed with the binding name", async () => {
    const ids: unknown[] = [];
    const def = sandbox({
      id: "w",
      tools: sandbox.tools.code({ only: ["run"] }),
    });
    const opened = openSandboxes({ work: def, spare: def }, {
      create: async () => {
        return {
          commands: {
            run: async (id: unknown) => {
              ids.push(id);

              return { stdout: "", stderr: "", exitCode: 0 };
            },
          },
        } as unknown as DurableSandbox;
      },
    } as unknown as DurableSandboxTools);
    const all = sandboxTools(opened) as unknown as Record<
      string,
      { run: (input: { command: string }, ctx: unknown) => Promise<unknown> }
    >;

    await all.work_run?.run({ command: "a" }, {});
    await all.spare_run?.run({ command: "b" }, {});

    expect(ids).toMatchObject([{ id: "work:run" }, { id: "spare:run" }]);
  });
});
