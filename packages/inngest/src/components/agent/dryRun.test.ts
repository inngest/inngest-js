/**
 * @module
 * Tests for `dryRun()`, through the same call check the loop and the sandbox
 * tool runner use.
 */
import { z } from "zod/v4";
import { resolveToolCall, type SandboxTools, tool } from "../sandbox/tools.ts";
import { dryRun } from "./dryRun.ts";

const input = z.object({ id: z.string() });
const calls: string[] = [];

const tools: SandboxTools = {
  getOrder: tool.step({
    input,
    effect: "read",
    output: z.object({ id: z.string() }),
    run: ({ id }) => {
      calls.push(`get ${id}`);

      return { id };
    },
  }),
  refund: tool.step({
    input,
    effect: "write",
    run: ({ id }) => {
      calls.push(`refund ${id}`);

      return "refunded";
    },
  }),
  wipe: tool.group({
    input,
    effect: "destructive",
    simulate: ({ id }) => {
      return { id, status: "wiped (pretend)" };
    },
    run: ({ id }) => {
      calls.push(`wipe ${id}`);

      return "wiped";
    },
  }),
  undeclared: tool.step({
    input,
    run: ({ id }) => {
      calls.push(`undeclared ${id}`);

      return "done";
    },
  }),
  http: tool.step({
    input: z.object({ method: z.string() }),
    effect: ({ method }) => {
      return method === "GET" ? "read" : "write";
    },
    displayName: ({ method }) => {
      return `HTTP ${method}`;
    },
    run: ({ method }) => {
      calls.push(`http ${method}`);

      return "sent";
    },
  }),
  positional: (a: unknown, b: unknown) => {
    calls.push("positional");

    return [a, b];
  },
};

const call = async (
  name: string,
  kwargs: Record<string, unknown> = {},
  args: unknown[] = [],
) => {
  const resolved = await resolveToolCall(
    dryRun(tools),
    { op: "call", id: 1, tool: name, args, kwargs },
    "{}",
  );

  if (!resolved.invoke) {
    throw new Error(resolved.error ?? "no invoke");
  }

  const value = await resolved.invoke({
    signal: new AbortController().signal,
    idempotencyKey: "k",
  });

  return { value, name: resolved.displayName, group: resolved.group };
};

beforeEach(() => {
  calls.length = 0;
});

describe("dryRun", () => {
  test("runs a read tool for real", async () => {
    const { value, name } = await call("getOrder", { id: "o1" });

    expect(value).toEqual({ id: "o1" });
    expect(name).toBeUndefined();
    expect(calls).toEqual(["get o1"]);
  });

  test("simulates a write by default, as a plain step named for the call", async () => {
    const { value, name, group } = await call("refund", { id: "o1" });

    expect(value).toEqual({
      dryRun: true,
      wouldCall: "refund",
      args: { id: "o1" },
    });
    expect(name).toBe("Would call: refund");
    expect(group).toBe(false);
    expect(calls).toEqual([]);
  });

  test("uses the tool's own simulate", async () => {
    const { value } = await call("wipe", { id: "o1" });

    expect(value).toEqual({ id: "o1", status: "wiped (pretend)" });
    expect(calls).toEqual([]);
  });

  test("counts a tool with no effect as a write", async () => {
    const { value } = await call("undeclared", { id: "o1" });

    expect(value).toMatchObject({ dryRun: true, wouldCall: "undeclared" });
    expect(calls).toEqual([]);
  });

  test("decides a function effect from the arguments", async () => {
    const get = await call("http", { method: "GET" });
    const post = await call("http", { method: "POST" });

    expect(get).toMatchObject({ value: "sent", name: "HTTP GET" });
    expect(post).toMatchObject({
      name: "Would call: http",
      value: { dryRun: true, args: { method: "POST" } },
    });
    expect(calls).toEqual(["http GET"]);
  });

  test("simulates a plain function with its positional arguments", async () => {
    const { value } = await call("positional", {}, [1, 2]);

    expect(value).toEqual({
      dryRun: true,
      wouldCall: "positional",
      args: [1, 2],
    });
  });

  test("leaves the tools it was given alone", () => {
    const before = tools.refund;

    dryRun(tools);

    expect(tools.refund).toBe(before);
  });
});
