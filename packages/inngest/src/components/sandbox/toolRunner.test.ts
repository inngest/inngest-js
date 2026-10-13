/**
 * @module
 * Tests for tools on `commands.run`, using a fake sandbox that plays the part
 * of the stub and the waiter, and a fake step that memoizes like replay.
 */
import { describe, expect, test, vi } from "vitest";
import { z } from "zod/v3";

import { NonRetriableError } from "../NonRetriableError.ts";
import { createDurableSandboxFacade } from "./durable.ts";
import {
  parseSandboxOperationForAction,
  type SandboxRawTool,
} from "./protocol.ts";
import { runCommandWithTools, type ToolsHost } from "./toolRunner.ts";
import type { SandboxTools } from "./tools.ts";
import { tool } from "./tools.ts";
import type { Sandbox } from "./types.ts";
import { encodeBase64 } from "./validation.ts";

const sandboxId = "22222222-2222-4222-8222-222222222222";

const sandboxRef = {
  kind: "inngest/sandbox" as const,
  version: 1 as const,
  id: sandboxId,
  name: "tools-box",
  status: "RUNNING" as const,
  vpcId: "11111111-1111-4111-8111-111111111111",
  imageRef: "default",
  resources: { vcpu: 2, memoryMb: 2048 },
  createdAt: "2026-07-28T00:00:00Z",
};

const request = (
  id: number,
  name: string,
  args: unknown[],
  kwargs?: Record<string, unknown>,
): string => {
  return `${JSON.stringify({ id, tool: name, args, ...(kwargs && { kwargs }) })}\n`;
};

interface FakeSandbox {
  log: string;
  stdout: string;
  exited: boolean;
  exitCode: number;
  started: number;
  waiterCalls: { offset: number; seconds: number }[];
  uploads: { path: string; body: string }[];
  killed: boolean;
  startedCommand: readonly string[];
  /**
   * Plays the sandbox code. Runs once at start and again each time a reply
   * lands, with the sequence number of that reply.
   */
  react: (fake: FakeSandbox, replied: number | undefined) => void;
  failUploadsOnce: number;
}

const createFakeSandbox = (react: FakeSandbox["react"]) => {
  const fake: FakeSandbox = {
    log: "",
    stdout: "",
    exited: false,
    exitCode: 0,
    started: 0,
    waiterCalls: [],
    uploads: [],
    killed: false,
    startedCommand: [],
    react,
    failUploadsOnce: 0,
  };
  const encoder = new TextEncoder();
  const processRef = () => {
    const self = {
      id: "proc-1",
      get state() {
        return fake.exited ? "EXITED" : fake.killed ? "KILLED" : "RUNNING";
      },
      get exitCode() {
        return fake.exited ? fake.exitCode : undefined;
      },
      wait: async () => {
        return self;
      },
      getOutput: async () => {
        return {
          chunks: [
            { stream: "STDOUT" as const, data: encoder.encode(fake.stdout) },
          ],
        };
      },
      signal: async () => {
        fake.killed = true;
      },
    };

    return self;
  };
  const sandbox = {
    commands: {
      run: async (command: string[]) => {
        const [, , , , , offset, seconds] = command;
        const bytes = encoder.encode(fake.log);
        const news = new TextDecoder().decode(bytes.subarray(Number(offset)));

        fake.waiterCalls.push({
          offset: Number(offset),
          seconds: Number(seconds),
        });

        return {
          stdout: `exit=${fake.exited ? 1 : 0}\n${news}`,
          stderr: "",
          exitCode: 0,
        };
      },
    },
    files: {
      upload: async ({ path, data }: { path: string; data: unknown }) => {
        if (fake.failUploadsOnce > 0) {
          fake.failUploadsOnce--;

          throw new Error("upload failed");
        }

        fake.uploads.push({ path, body: String(data) });
        fake.react(fake, Number(path.split("/").pop()?.replace(".json", "")));

        return { path, bytesWritten: 0 };
      },
    },
    processes: {
      start: async (options: { command: readonly string[] }) => {
        fake.started++;
        fake.startedCommand = options.command;
        fake.react(fake, undefined);

        return processRef();
      },
      get: async () => {
        return processRef();
      },
    },
  } as unknown as Sandbox;

  return { fake, sandbox };
};

/**
 * A host whose steps memoize through a JSON round trip, like replay.
 */
const createHost = (
  sandbox: Sandbox,
  memo: Map<string, string> = new Map(),
): {
  host: ToolsHost;
  executed: string[];
  attempts: Map<string, number>;
  memo: Map<string, string>;
} => {
  const executed: string[] = [];
  const attempts = new Map<string, number>();
  const host: ToolsHost = {
    run: async <T>(
      idOrOptions: string | { id: string },
      fn: () => Promise<T>,
    ) => {
      const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      const hit = memo.get(id);
      if (hit !== undefined) {
        return JSON.parse(hit) as T;
      }

      // Like the engine, retry a failed step once, except tools (whose failure
      // is the point) and steps that said not to.
      let value: T;
      for (let attempt = 1; ; attempt++) {
        attempts.set(id, attempt);

        try {
          value = await fn();

          break;
        } catch (error) {
          if (
            attempt > 1 ||
            id.includes(":tool:") ||
            error instanceof NonRetriableError
          ) {
            throw error;
          }
        }
      }

      executed.push(id);
      memo.set(id, JSON.stringify(value ?? null));

      return JSON.parse(memo.get(id) ?? "null") as T;
    },
    getSandbox: async () => {
      return sandbox;
    },
    runId: "run-1",
  };

  return { host, executed, attempts, memo };
};

const operation = (command: string, timeoutMs = 300_000) => {
  return parseSandboxOperationForAction("exec", {
    protocolVersion: 1,
    action: "exec",
    target: { sandbox: sandboxRef },
    input: [{ command: ["/bin/sh", "-c", command], timeoutMs }],
  });
};

const exitWith = (fake: FakeSandbox, stdout = "done\n", code = 0): void => {
  fake.stdout = stdout;
  fake.exitCode = code;
  fake.exited = true;
  fake.log += "";
};

const reply = (fake: FakeSandbox, seq: number): unknown => {
  const upload = fake.uploads.find((candidate) => {
    return candidate.path.endsWith(`/${seq}.json`);
  });

  return upload ? JSON.parse(upload.body) : undefined;
};

const run = (
  host: ToolsHost,
  tools: SandboxTools,
  toolOptions: Parameters<typeof runCommandWithTools>[3]["toolOptions"] = {},
) => {
  return runCommandWithTools(host, "exec", operation("python3 x.py"), {
    tools,
    toolOptions: { waitWindow: 5, ...toolOptions },
  });
};

describe("commands.run with tools", () => {
  test("a fast command is one step and never touches a tool", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        exitWith(f, "hello\n", 0);
      }
    });
    const { host, executed } = createHost(sandbox);
    const getCustomer = vi.fn();

    const result = await run(host, { getCustomer });

    expect(executed).toEqual(["exec"]);
    expect(fake.started).toBe(1);
    expect(fake.waiterCalls).toHaveLength(1);
    expect(getCustomer).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("ships the stub inside the command, with the user's command last", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        exitWith(f);
      }
    });
    const { host } = createHost(sandbox);

    await run(host, {});

    const [shell, flag, script, , ...command] = fake.startedCommand;

    expect(shell).toBe("/bin/sh");
    expect(flag).toBe("-c");
    expect(script).toContain("inngest_tools.py");
    expect(script).toContain("inngest_tools/index.js");
    expect(command).toEqual(["/bin/sh", "-c", "python3 x.py"]);
    expect(fake.uploads).toEqual([]);
  });

  test("wakes on the first request and replies in the next wait step", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log += request(1, "getCustomer", ["cus_1"]);
      }
      if (replied === 1) {
        exitWith(f, "pro\n");
      }
    });
    const { host, executed } = createHost(sandbox);
    const getCustomer = vi.fn(async (id: string) => {
      return { id, plan: "pro" };
    });

    const result = await run(host, { getCustomer });

    expect(getCustomer).toHaveBeenCalledExactlyOnceWith("cus_1");
    expect(executed).toEqual([
      "exec",
      "exec:tool:getCustomer:1",
      "exec:wait:1",
    ]);
    expect(reply(fake, 1)).toEqual({ result: { id: "cus_1", plan: "pro" } });
    expect(fake.waiterCalls[0]).toEqual({ offset: 0, seconds: 1 });
    expect(fake.waiterCalls[1]?.offset).toBe(
      new TextEncoder().encode(request(1, "getCustomer", ["cus_1"])).length,
    );
    expect(result.stdout).toBe("pro\n");
  });

  test("a failed reply upload retries without running the tool again", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log += request(1, "sendSlack", ["hi"]);
      }
      if (replied === 1) {
        exitWith(f);
      }
    });
    const { host, executed, attempts } = createHost(sandbox);
    const sendSlack = vi.fn(async () => {
      return { ok: true };
    });

    fake.failUploadsOnce = 1;

    const result = await run(host, { sendSlack });

    expect(sendSlack).toHaveBeenCalledTimes(1);
    expect(attempts.get("exec:wait:1")).toBe(2);
    expect(
      executed.filter((id) => id === "exec:tool:sendSlack:1"),
    ).toHaveLength(1);
    expect(fake.uploads.filter((u) => u.path.endsWith("/1.json"))).toHaveLength(
      1,
    );
    expect(result.exitCode).toBe(0);
  });

  test("replay serves memoized steps without touching the sandbox or tools", async () => {
    const script: FakeSandbox["react"] = (f, replied) => {
      if (replied === undefined) {
        f.log += request(1, "sendSlack", ["hi"]);
      }
      if (replied === 1) {
        exitWith(f);
      }
    };
    const memo = new Map<string, string>();
    const sendSlack = vi.fn(async () => {
      return 1;
    });
    const firstRun = createFakeSandbox(script);

    await run(createHost(firstRun.sandbox, memo).host, { sendSlack });

    const replay = createFakeSandbox(script);
    const result = await run(createHost(replay.sandbox, memo).host, {
      sendSlack,
    });

    expect(sendSlack).toHaveBeenCalledTimes(1);
    expect(replay.fake.started).toBe(0);
    expect(replay.fake.uploads).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test("runs parallel calls together and replies to all in one wait step", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log +=
          request(1, "slow", [1]) +
          request(2, "slow", [2]) +
          request(3, "slow", [3]);
      }
      if (f.uploads.length === 3) {
        exitWith(f);
      }
    });
    const { host, executed } = createHost(sandbox);
    let running = 0;
    let peak = 0;
    const slow = async (n: number) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => {
        return setTimeout(resolve, 5);
      });
      running--;

      return n * 2;
    };

    await run(host, { slow });

    expect(peak).toBe(3);
    expect(executed.filter((id) => id.includes(":wait:"))).toEqual([
      "exec:wait:1",
    ]);
    expect([1, 2, 3].map((seq) => reply(fake, seq))).toEqual([
      { result: 2 },
      { result: 4 },
      { result: 6 },
    ]);
  });

  test("caps parallel calls at 8 and answers the rest in the next round", async () => {
    const calls = Array.from({ length: 10 }, (_, i) => i + 1);
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log += calls.map((n) => request(n, "t", [n])).join("");
      }
      if (f.uploads.length === 10) {
        exitWith(f);
      }
    });
    const { host } = createHost(sandbox);
    let running = 0;
    let peak = 0;
    const t = async (n: number) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => {
        return setTimeout(resolve, 2);
      });
      running--;

      return n;
    };

    await run(host, { t }, { waitWindow: 5000 });

    expect(peak).toBe(8);
    expect(fake.uploads).toHaveLength(10);
    expect(fake.waiterCalls[1]?.seconds).toBe(0);
  });

  test("a tool that throws becomes an error reply after the step fails", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log += request(1, "boom", []);
      }
      if (replied === 1) {
        exitWith(f, "", 1);
      }
    });
    const { host } = createHost(sandbox);
    const result = await run(host, {
      boom: async () => {
        throw new Error("kaput");
      },
    });

    expect(reply(fake, 1)).toEqual({ error: "kaput" });
    expect(result.exitCode).toBe(1);
  });

  test("answers unknown and inherited names without a step", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log += request(1, "rm_rf", []) + request(2, "constructor", ["x"]);
      }
      if (f.uploads.length === 2) {
        exitWith(f);
      }
    });
    const { host, executed } = createHost(sandbox);
    const known = vi.fn();

    await run(host, { known });

    expect(known).not.toHaveBeenCalled();
    expect(executed.some((id) => id.includes(":tool:"))).toBe(false);
    expect(reply(fake, 1)).toEqual({ error: "Unknown tool: rm_rf" });
    expect(reply(fake, 2)).toEqual({ error: "Unknown tool: constructor" });
  });

  test("validates named arguments with the input schema before any step", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log +=
          request(1, "getCustomer", [], { id: 5 }) +
          request(2, "getCustomer", [], { id: "cus_2" }) +
          request(3, "getCustomer", ["a", "b"]);
      }
      if (f.uploads.length === 3) {
        exitWith(f);
      }
    });
    const { host, executed } = createHost(sandbox);
    const runTool = vi.fn(async ({ id }: { id: string }) => {
      return { id };
    });

    await run(host, {
      getCustomer: tool({ input: z.object({ id: z.string() }), run: runTool }),
    });

    expect(runTool).toHaveBeenCalledExactlyOnceWith(
      { id: "cus_2" },
      expect.objectContaining({
        idempotencyKey: "run-1:exec:tool:getCustomer:2",
      }),
    );
    expect(executed.filter((id) => id.includes(":tool:"))).toEqual([
      "exec:tool:getCustomer:2",
    ]);
    expect(JSON.stringify(reply(fake, 1))).toContain(
      "Invalid arguments for getCustomer: id: Expected string",
    );
    expect(reply(fake, 2)).toEqual({ result: { id: "cus_2" } });
    expect(JSON.stringify(reply(fake, 3))).toContain("named arguments");
  });

  test("a tool result the output schema rejects fails the tool step", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log += request(1, "count", []);
      }
      if (replied === 1) {
        exitWith(f);
      }
    });
    const { host } = createHost(sandbox);
    await run(host, {
      count: tool({
        output: z.object({ n: z.number() }),
        run: async () => {
          return { n: "nope" };
        },
      }),
    });

    expect(JSON.stringify(reply(fake, 1))).toContain(
      "count returned an invalid result",
    );
  });

  test("a reply over 1 MiB fails the tool step with a clear error", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log += request(1, "big", []);
      }
      if (replied === 1) {
        exitWith(f);
      }
    });
    const { host } = createHost(sandbox);
    await run(host, {
      big: async () => {
        return "x".repeat(1024 * 1024);
      },
    });

    expect(JSON.stringify(reply(fake, 1))).toContain(
      "write large data to a file",
    );
  });

  test("answers a request over 256 KiB without running the tool", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log += request(1, "eat", ["x".repeat(256 * 1024)]);
      }
      if (replied === 1) {
        exitWith(f);
      }
    });
    const { host } = createHost(sandbox);
    const eat = vi.fn();

    await run(host, { eat });

    expect(eat).not.toHaveBeenCalled();
    expect(JSON.stringify(reply(fake, 1))).toContain(
      "larger than 262144 bytes",
    );
  });

  test("a tool that outlives its timeout fails with a timeout error", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log += request(1, "hang", []);
      }
      if (replied === 1) {
        exitWith(f);
      }
    });
    const { host } = createHost(sandbox);
    await run(
      host,
      {
        hang: async (): Promise<void> => {
          await new Promise(() => {
            return undefined;
          });
        },
      },
      { toolTimeout: 10 },
    );

    expect(reply(fake, 1)).toEqual({ error: "hang timed out after 10ms" });
  });

  test("kills the process and throws past the call cap", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        f.log +=
          request(1, "t", []) + request(2, "t", []) + request(3, "t", []);
      }
    });
    const { host, executed } = createHost(sandbox);

    await expect(
      run(host, { t: async () => 1 }, { maxCalls: 2 }),
    ).rejects.toThrow("more than 2 tool calls");

    expect(executed).toContain("exec:abort");
    expect(fake.killed).toBe(true);
  });

  test("kills the process and throws past the wall-clock timeout", async () => {
    const { fake, sandbox } = createFakeSandbox(() => undefined);
    const { host } = createHost(sandbox);

    await expect(
      runCommandWithTools(host, "exec", operation("sleep 99", 1), {
        tools: {},
        toolOptions: { waitWindow: 10 },
      }),
    ).rejects.toThrow("exceeded its 1ms timeout");

    expect(fake.killed).toBe(true);
  });

  test("a quiet stretch continues in a fresh wait step", async () => {
    let waits = 0;
    const { fake, sandbox } = createFakeSandbox((f) => {
      if (waits >= 2) {
        exitWith(f);
      }
    });
    const { host, executed } = createHost(sandbox);
    const inner = host.run;

    host.run = async (idOrOptions, fn, meta) => {
      const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      if (id.includes(":wait:")) {
        waits++;
        if (waits === 2) {
          fake.react(fake, 99);
        }
      }

      return inner(idOrOptions, fn, meta);
    };

    await run(host, {}, { waitWindow: 1 });

    expect(executed).toEqual(["exec", "exec:wait:1", "exec:wait:2"]);
  });

  test("validates tool names before starting anything", async () => {
    const { fake, sandbox } = createFakeSandbox(() => undefined);
    const { host } = createHost(sandbox);

    await expect(
      run(host, { 'x"; import os #': async () => undefined }),
    ).rejects.toThrow("Invalid tool name");
    await expect(run(host, { then: async () => undefined })).rejects.toThrow(
      "Invalid tool name",
    );

    expect(fake.started).toBe(0);
  });

  test("does not retry a start step that failed after the process began", async () => {
    const { sandbox } = createFakeSandbox(() => undefined);
    const { host } = createHost(sandbox);

    (sandbox.commands as { run: unknown }).run = async () => {
      throw new Error("waiter blew up");
    };

    await expect(run(host, {})).rejects.toBeInstanceOf(NonRetriableError);
  });

  test("returns output that is a base64 round trip of what the process printed", async () => {
    const { sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        exitWith(f, "héllo ✓\n", 7);
      }
    });
    const { host } = createHost(sandbox);

    const result = await run(host, {});

    expect(result.stdout).toBe("héllo ✓\n");
    expect(result.exitCode).toBe(7);
    expect(encodeBase64(new TextEncoder().encode(result.stdout))).toBeTruthy();
  });
});

describe("durable commands.run routing", () => {
  const execResult = {
    protocolVersion: 1,
    action: "exec",
    result: {
      stdout: "",
      stderr: "",
      encoding: "base64",
      exitCode: 0,
      output: { truncated: false },
    },
  };

  test("without tools it is the same single exec step", async () => {
    const rawTool: SandboxRawTool = Object.assign(
      vi.fn(async () => {
        return execResult;
      }),
      { runWithTools: vi.fn() },
    );
    const sandbox = createDurableSandboxFacade(sandboxRef, () => {
      return rawTool;
    });

    await sandbox.commands.run("exec", "true");

    expect(rawTool).toHaveBeenCalledTimes(1);
    expect(rawTool.runWithTools).not.toHaveBeenCalled();
  });

  test("with tools it hands the exec to the tools runner with a 5m default timeout", async () => {
    const runWithTools = vi.fn(async () => {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        output: { truncated: false as const },
      };
    });
    const rawTool: SandboxRawTool = Object.assign(vi.fn(), { runWithTools });
    const sandbox = createDurableSandboxFacade(sandboxRef, () => {
      return rawTool;
    });
    const tools = { a: async () => 1 };

    await sandbox.commands.run("exec", "true", { tools });

    expect(rawTool).not.toHaveBeenCalled();
    expect(runWithTools).toHaveBeenCalledWith(
      "exec",
      expect.objectContaining({
        input: [expect.objectContaining({ timeoutMs: 300_000 })],
      }),
      { tools, toolOptions: undefined },
    );
  });

  test("with tools but no sandbox middleware it explains what is missing", async () => {
    const sandbox = createDurableSandboxFacade(sandboxRef, () => {
      return vi.fn();
    });

    await expect(
      sandbox.commands.run("exec", "true", { tools: {} }),
    ).rejects.toThrow("sandboxMiddleware()");
  });
});
