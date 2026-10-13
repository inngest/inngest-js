/**
 * @module
 * Tests for the experimental sandbox RPC callbacks, using a fake sandbox that
 * plays the part of the stub and a memoizing fake `step`.
 */
import { describe, expect, test, vi } from "vitest";

import { buildPythonStub, runWithTools } from "./rpc.ts";
import type { SandboxClient } from "./types.ts";

const encoder = new TextEncoder();

const request = (id: number, tool: string, args: unknown[]): string => {
  return `::inngest-rpc::${JSON.stringify({ id, tool, args })}\n`;
};

/**
 * A fake sandbox. `onUpload` plays the sandbox code: it reacts to reply files
 * by printing more output or exiting.
 */
const createFakeSandbox = (options: {
  initialOutput: string;
  exitCode?: number;
  onUpload?: (path: string, body: string, fake: FakeSandbox) => void;
}) => {
  const fake: FakeSandbox = {
    stdout: "",
    stderr: "",
    state: options.exitCode === undefined ? "RUNNING" : "EXITED",
    exitCode: options.exitCode,
    uploads: [],
    started: 0,
    getCalls: 0,
  };

  const processRef = () => {
    return {
      id: "proc-1",
      get state() {
        return fake.state;
      },
      get exitCode() {
        return fake.exitCode;
      },
      getOutput: async () => {
        return {
          chunks: [
            { stream: "STDOUT" as const, data: encoder.encode(fake.stdout) },
            { stream: "STDERR" as const, data: encoder.encode(fake.stderr) },
          ],
        };
      },
      signal: async () => {
        fake.state = "KILLED";
      },
    };
  };

  const sandbox = {
    commands: {
      run: async () => {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
    files: {
      upload: async ({ path, data }: { path: string; data: unknown }) => {
        const body = String(data);

        fake.uploads.push({ path, body });
        options.onUpload?.(path, body, fake);

        return { path, bytesWritten: body.length };
      },
    },
    processes: {
      start: async () => {
        fake.started++;
        fake.stdout = options.initialOutput;

        return processRef();
      },
      get: async () => {
        return processRef();
      },
    },
  };

  const client = {
    get: async () => {
      fake.getCalls++;

      return sandbox;
    },
  } as unknown as SandboxClient;

  return { fake, client };
};

interface FakeSandbox {
  stdout: string;
  stderr: string;
  state: string;
  exitCode: number | undefined;
  uploads: { path: string; body: string }[];
  started: number;
  getCalls: number;
}

/**
 * A `step.run` that memoizes by ID through a JSON round trip, like replay.
 */
const createMemoStep = (memo: Map<string, string> = new Map()) => {
  const executed: string[] = [];

  return {
    memo,
    executed,
    step: {
      run: async (id: string, fn: () => Promise<unknown>) => {
        const hit = memo.get(id);
        if (hit !== undefined) {
          return JSON.parse(hit);
        }

        const value = await fn();

        executed.push(id);
        memo.set(id, JSON.stringify(value ?? null));

        return JSON.parse(memo.get(id) ?? "null");
      },
    },
  };
};

const fast = { pollWindowMs: 50, pollIntervalMs: 1 };

const exitWithResult = (fake: FakeSandbox, value: unknown): void => {
  fake.stdout += `hello\n::inngest-result::${JSON.stringify(value)}\n`;
  fake.state = "EXITED";
  fake.exitCode = 0;
};

describe("runWithTools", () => {
  test("turns a request line into a call step and a reply upload", async () => {
    const { fake, client } = createFakeSandbox({
      initialOutput: request(1, "getCustomer", ["cus_1"]),
      onUpload: (path, _body, f) => {
        if (path === "/inngest/rpc/1.json") {
          exitWithResult(f, "pro");
        }
      },
    });
    const getCustomer = vi.fn(async (id: string) => {
      return { id, plan: "pro" };
    });
    const { step, executed } = createMemoStep();

    const out = await runWithTools(step, "analyse", {
      sandbox: { id: "sbx" },
      sandboxes: client,
      language: "python",
      code: 'result(getCustomer("cus_1")["plan"])',
      tools: { getCustomer },
      ...fast,
    });

    expect(getCustomer).toHaveBeenCalledExactlyOnceWith("cus_1");
    expect(executed).toEqual([
      "analyse:setup",
      "analyse:start",
      "analyse:poll:0",
      "analyse:call:getCustomer:1",
      "analyse:poll:1",
    ]);
    expect(
      JSON.parse(
        fake.uploads.find((u) => {
          return u.path === "/inngest/rpc/1.json";
        })?.body ?? "",
      ),
    ).toEqual({ result: { id: "cus_1", plan: "pro" } });
    expect(fake.uploads.map((u) => u.path)).toEqual([
      "/inngest/rpc.py",
      "/inngest/run.py",
      "/inngest/main.py",
      "/inngest/rpc/1.json",
    ]);
    expect(out).toEqual({
      result: "pro",
      stdout: "hello",
      stderr: "",
      exitCode: 0,
      calls: [{ seq: 1, tool: "getCustomer", ok: true }],
    });
  });

  test("replay serves memoized steps without re-running tools or touching the sandbox", async () => {
    const run = async (memo: Map<string, string>) => {
      const { fake, client } = createFakeSandbox({
        initialOutput: request(1, "sendSlack", ["hi"]),
        onUpload: (path, _body, f) => {
          if (path === "/inngest/rpc/1.json") {
            exitWithResult(f, 1);
          }
        },
      });
      const sendSlack = vi.fn(async () => {
        return { ok: true };
      });
      const { step } = createMemoStep(memo);
      const out = await runWithTools(step, "a", {
        sandbox: { id: "sbx" },
        sandboxes: client,
        language: "python",
        code: "",
        tools: { sendSlack },
        ...fast,
      });

      return { out, fake, sendSlack };
    };

    const memo = new Map<string, string>();
    const first = await run(memo);
    const replay = await run(memo);

    expect(first.sendSlack).toHaveBeenCalledTimes(1);
    expect(replay.sendSlack).not.toHaveBeenCalled();
    expect(replay.fake.getCalls).toBe(0);
    expect(replay.fake.uploads).toEqual([]);
    expect(replay.fake.started).toBe(0);
    expect(replay.out).toEqual(first.out);
  });

  test("sends tool errors back to the sandbox as {error}", async () => {
    const { fake, client } = createFakeSandbox({
      initialOutput: request(1, "boom", []),
      onUpload: (path, _body, f) => {
        if (path === "/inngest/rpc/1.json") {
          f.state = "EXITED";
          f.exitCode = 1;
          f.stderr = "RpcError: nope\n";
        }
      },
    });
    const { step } = createMemoStep();

    const out = await runWithTools(step, "a", {
      sandbox: { id: "sbx" },
      sandboxes: client,
      language: "python",
      code: "",
      tools: {
        boom: async () => {
          throw new Error("kaput");
        },
      },
      ...fast,
    });

    expect(
      JSON.parse(
        fake.uploads.find((u) => {
          return u.path === "/inngest/rpc/1.json";
        })?.body ?? "",
      ),
    ).toEqual({ error: "kaput" });
    expect(out.calls).toEqual([
      { seq: 1, tool: "boom", ok: false, error: "kaput" },
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe("RpcError: nope\n");
  });

  test("rejects unknown and inherited tool names without calling anything", async () => {
    const { fake, client } = createFakeSandbox({
      initialOutput: request(1, "rm_rf", []) + request(2, "constructor", ["x"]),
      onUpload: (path, _body, f) => {
        if (path === "/inngest/rpc/2.json") {
          exitWithResult(f, null);
        }
      },
    });
    const { step, executed } = createMemoStep();
    const known = vi.fn();

    const out = await runWithTools(step, "a", {
      sandbox: { id: "sbx" },
      sandboxes: client,
      language: "python",
      code: "",
      tools: { known },
      ...fast,
    });

    expect(known).not.toHaveBeenCalled();
    expect(executed).toContain("a:call:unknown:1");
    expect(executed).toContain("a:call:unknown:2");
    expect(out.calls.map((c) => c.ok)).toEqual([false, false]);
    expect(
      JSON.parse(
        fake.uploads.find((u) => {
          return u.path === "/inngest/rpc/1.json";
        })?.body ?? "",
      ),
    ).toEqual({ error: "Unknown tool: rm_rf" });
  });

  test("treats malformed and invalid requests as plain output", async () => {
    const { client } = createFakeSandbox({
      initialOutput:
        '::inngest-rpc::{not json}\n::inngest-rpc::{"id":0,"tool":"t","args":[]}\n',
      exitCode: 0,
    });
    const { step } = createMemoStep();

    const out = await runWithTools(step, "a", {
      sandbox: { id: "sbx" },
      sandboxes: client,
      language: "python",
      code: "",
      tools: {},
      ...fast,
    });

    expect(out.calls).toEqual([]);
    expect(out.stdout).toContain("{not json}");
  });

  test("returns the exit code and output when the process exits without calls", async () => {
    const { client } = createFakeSandbox({
      initialOutput: "a\nb\n",
      exitCode: 3,
    });
    const { step } = createMemoStep();

    const out = await runWithTools(step, "a", {
      sandbox: { id: "sbx" },
      sandboxes: client,
      language: "python",
      code: "",
      tools: {},
      ...fast,
    });

    expect(out).toEqual({
      result: undefined,
      stdout: "a\nb",
      stderr: "",
      exitCode: 3,
      calls: [],
    });
  });

  test("kills the process and throws after maxPolls", async () => {
    const { fake, client } = createFakeSandbox({ initialOutput: "" });
    const { step, executed } = createMemoStep();

    await expect(
      runWithTools(step, "a", {
        sandbox: { id: "sbx" },
        sandboxes: client,
        language: "python",
        code: "",
        tools: {},
        maxPolls: 2,
        pollWindowMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("Exceeded maxPolls (2)");

    expect(executed).toEqual([
      "a:setup",
      "a:start",
      "a:poll:0",
      "a:poll:1",
      "a:abort",
    ]);
    expect(fake.state).toBe("KILLED");
  });

  test("rejects invalid tool names before doing anything", async () => {
    const { fake, client } = createFakeSandbox({ initialOutput: "" });
    const { step } = createMemoStep();

    await expect(
      runWithTools(step, "a", {
        sandbox: { id: "sbx" },
        sandboxes: client,
        language: "python",
        code: "",
        tools: { 'x"; import os #': async () => {} },
      }),
    ).rejects.toThrow("Invalid tool name");

    expect(fake.getCalls).toBe(0);
  });

  test("builds a stub that defines each tool", () => {
    const stub = buildPythonStub(["getCustomer", "sendSlack"], 60);

    expect(stub).toContain('_TOOLS = ["getCustomer","sendSlack"]');
    expect(stub).toContain("_TIMEOUT = 60");
    expect(stub).toContain("::inngest-rpc::");
  });
});
