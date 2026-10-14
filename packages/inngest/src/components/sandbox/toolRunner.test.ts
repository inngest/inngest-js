/**
 * @module
 * Tests for tools on `commands.run`, using a fake sandbox that plays the part
 * of the stub and the waiter, and a fake step that memoizes like replay.
 */
import { describe, expect, test, vi } from "vitest";
import { z } from "zod/v3";
import type { StepOptions } from "../../types.ts";
import { getAsyncCtxSync, runWithAsyncCtx } from "../execution/als.ts";
import { withSpan } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { createDurableSandboxFacade } from "./durable.ts";
import {
  parseSandboxOperationForAction,
  type SandboxRawTool,
} from "./protocol.ts";
import { runCommandWithTools, type ToolsHost } from "./toolRunner.ts";
import { type SandboxTools, tool } from "./tools.ts";
import type { Sandbox } from "./types.ts";

const sandboxRef = {
  kind: "inngest/sandbox" as const,
  version: 1 as const,
  id: "22222222-2222-4222-8222-222222222222",
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
  args: unknown[] = [],
  kwargs?: Record<string, unknown>,
): string => {
  return `${JSON.stringify({ id, tool: name, args, ...(kwargs && { kwargs }) })}\n`;
};

const base64 = (text: string): string => {
  return Buffer.from(text).toString("base64");
};

interface Fake {
  log: string;
  stdout: string;
  exitCode?: number;
  killed: boolean;
  started: number;
  waits: { lines: number; seconds: number }[];
  uploads: { path: string; body: string }[];
  failUploads: number;
  /**
   * Plays the sandbox code. Runs when the process starts and again each time
   * a reply lands, with the id of that reply.
   */
  react: (fake: Fake, replied: number | undefined) => void;
}

const exitWith = (fake: Fake, stdout = "done\n", code = 0): void => {
  fake.stdout = stdout;
  fake.exitCode = code;
};

const createFakeSandbox = (react: Fake["react"]) => {
  const fake: Fake = {
    log: "",
    stdout: "",
    killed: false,
    started: 0,
    waits: [],
    uploads: [],
    failUploads: 0,
    react,
  };
  const sandbox = {
    commands: {
      run: async (command: string[]) => {
        const [, , , , , lines, seconds] = command;

        // The real waiter blocks, so replies uploaded alongside it land first.
        await new Promise((resolve) => {
          return setTimeout(resolve, 0);
        });

        const news = fake.log.split("\n").slice(Number(lines), -1);

        fake.waits.push({ lines: Number(lines), seconds: Number(seconds) });

        return {
          stdout: [
            fake.exitCode ?? "",
            fake.exitCode === undefined ? "" : base64(fake.stdout),
            "",
            ...news,
            "",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      },
    },
    files: {
      upload: async ({ path, data }: { path: string; data: unknown }) => {
        if (fake.failUploads > 0) {
          fake.failUploads--;

          throw new Error("upload failed");
        }

        fake.uploads.push({ path, body: String(data) });
        fake.react(fake, Number(path.split("/").pop()?.replace(".json", "")));

        return { path, bytesWritten: 0 };
      },
    },
    processes: {
      start: async () => {
        fake.started++;
        fake.react(fake, undefined);

        return { id: "proc-1" };
      },
      get: async () => {
        return {
          signal: async () => {
            fake.killed = true;
          },
        };
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
) => {
  const executed: string[] = [];
  const attempts = new Map<string, number>();
  const spans = new Map<string, unknown[]>();
  const names = new Map<string, string | undefined>();
  const host: ToolsHost = {
    run: async <T>(idOrOptions: string | StepOptions, fn: () => Promise<T>) => {
      const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      names.set(
        id,
        typeof idOrOptions === "string" ? undefined : idOrOptions.name,
      );

      const own =
        typeof idOrOptions === "string" ? undefined : idOrOptions["~span"];
      spans.set(id, [
        ...(getAsyncCtxSync()?.execution?.span ?? []),
        ...(own ? [own] : []),
      ]);
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
    sandbox,
    runId: "run-1",
  };

  return { host, executed, attempts, spans, names };
};

const operation = (
  timeoutMs = 300_000,
  command = ["/bin/sh", "-c", "python3 x.py"],
) => {
  return parseSandboxOperationForAction("exec", {
    protocolVersion: 1,
    action: "exec",
    target: { sandbox: sandboxRef },
    input: [{ command, timeoutMs }],
  });
};

const run = (
  host: ToolsHost,
  tools: SandboxTools,
  toolOptions: Parameters<typeof runCommandWithTools>[3]["toolOptions"] = {},
  timeoutMs?: number,
) => {
  return runCommandWithTools(host, "exec", operation(timeoutMs), {
    tools,
    toolOptions: { waitWindow: 5, ...toolOptions },
  });
};

const stdoutOf = (result: Awaited<ReturnType<typeof run>>): string => {
  return Buffer.from(
    (result as { result: { stdout: string } }).result.stdout,
    "base64",
  ).toString();
};

/**
 * Makes the code send `requests` at start and exit once every one is answered.
 */
const sendAll = (requests: string[]): Fake["react"] => {
  return (fake, replied) => {
    if (replied === undefined) {
      fake.log += requests.join("");
    }

    if (fake.uploads.length === requests.length) {
      exitWith(fake);
    }
  };
};

const replies = (fake: Fake): unknown[] => {
  return fake.uploads
    .map((upload) => {
      return {
        id: Number(upload.path.match(/(\d+)\.json$/)?.[1]),
        ...JSON.parse(upload.body),
      };
    })
    .sort((a, b) => {
      return a.id - b.id;
    });
};

interface ReplyCase {
  name: string;
  tools: SandboxTools;
  requests: string[];
  replies: unknown[];
  steps: string[];
}

describe("commands.run with tools", () => {
  test("a fast command is one step, touches no tool and returns its output", async () => {
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        exitWith(f, "héllo ✓\n", 7);
      }
    });
    const { host, executed } = createHost(sandbox);
    const getCustomer = vi.fn();

    const result = await run(host, { getCustomer });

    expect(executed).toEqual(["exec"]);
    expect(fake.started).toBe(1);
    expect(fake.waits).toHaveLength(1);
    expect(getCustomer).not.toHaveBeenCalled();
    expect(stdoutOf(result)).toBe("héllo ✓\n");
    expect(result).toMatchObject({ result: { exitCode: 7 } });
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
    expect(replies(fake)).toEqual([
      { id: 1, result: { id: "cus_1", plan: "pro" } },
    ]);
    expect(fake.waits).toEqual([
      { lines: 0, seconds: 1 },
      { lines: 1, seconds: 1 },
    ]);
    expect(stdoutOf(result)).toBe("pro\n");
  });

  test.each<ReplyCase>([
    {
      name: "unknown and inherited names, without a step",
      tools: { known: vi.fn() },
      requests: [request(1, "rm_rf"), request(2, "constructor", ["x"])],
      replies: [
        { id: 1, error: "Unknown tool: rm_rf" },
        { id: 2, error: "Unknown tool: constructor" },
      ],
      steps: [],
    },
    {
      name: "named arguments checked against the input schema",
      tools: {
        getCustomer: tool.step({
          input: z.object({ id: z.string() }),
          run: async ({ id }) => {
            return { id };
          },
        }),
      },
      requests: [
        request(1, "getCustomer", [], { id: 5 }),
        request(2, "getCustomer", [], { id: "cus_2" }),
        request(3, "getCustomer", ["a", "b"]),
      ],
      replies: [
        {
          id: 1,
          error:
            "Invalid arguments for getCustomer: id: Expected string, received number",
        },
        { id: 2, result: { id: "cus_2" } },
        { id: 3, error: "getCustomer takes one set of named arguments" },
      ],
      steps: ["exec:tool:getCustomer:2"],
    },
    {
      name: "named arguments to a tool with no input schema",
      tools: { plain: async () => 1 },
      requests: [request(1, "plain", [], { a: 1 })],
      replies: [{ id: 1, error: "plain takes positional arguments only" }],
      steps: [],
    },
    {
      name: "a tool that throws, after its step fails",
      tools: {
        boom: async () => {
          throw new Error("kaput");
        },
      },
      requests: [request(1, "boom")],
      replies: [{ id: 1, error: "kaput" }],
      steps: [],
    },
    {
      name: "a result the output schema rejects",
      tools: {
        count: tool.step({
          output: z.object({ n: z.number() }),
          run: async () => {
            return { n: "nope" };
          },
        }),
      },
      requests: [request(1, "count")],
      replies: [
        {
          id: 1,
          error:
            "count returned an invalid result: n: Expected number, received string",
        },
      ],
      steps: [],
    },
    {
      name: "a reply over 1 MiB",
      tools: {
        big: async () => {
          return "x".repeat(1024 * 1024);
        },
      },
      requests: [request(1, "big")],
      replies: [
        {
          id: 1,
          error:
            "big returned more than 1048576 bytes; write large data to a file instead",
        },
      ],
      steps: [],
    },
    {
      name: "a request over 256 KiB, without running the tool",
      tools: { eat: vi.fn() },
      requests: [request(1, "eat", ["x".repeat(256 * 1024)])],
      replies: [{ id: 1, error: "Request is larger than 262144 bytes" }],
      steps: [],
    },
  ])("answers $name", async ({ tools, requests, replies: expected, steps }) => {
    const { fake, sandbox } = createFakeSandbox(sendAll(requests));
    const { host, executed } = createHost(sandbox);

    await run(host, tools);

    expect(replies(fake)).toEqual(expected);
    expect(executed.filter((id) => id.includes(":tool:"))).toEqual(steps);
  });

  test("passes the run-scoped idempotency key to a tool", async () => {
    const { sandbox } = createFakeSandbox(
      sendAll([request(1, "getCustomer", [], { id: "cus_2" })]),
    );
    const { host } = createHost(sandbox);
    const runTool = vi.fn(async ({ id }: { id: string }) => {
      return { id };
    });

    await run(host, {
      getCustomer: tool.step({
        input: z.object({ id: z.string() }),
        run: runTool,
      }),
    });

    expect(runTool).toHaveBeenCalledExactlyOnceWith(
      { id: "cus_2" },
      expect.objectContaining({
        idempotencyKey: "run-1:exec:tool:getCustomer:1",
      }),
    );
  });

  test("a tool that outlives its timeout fails with a timeout error", async () => {
    const { fake, sandbox } = createFakeSandbox(sendAll([request(1, "hang")]));
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

    expect(replies(fake)).toEqual([
      { id: 1, error: "hang timed out after 10ms" },
    ]);
  });

  test("runs parallel calls together, up to 8 at once, and replies in one wait step", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const { fake, sandbox } = createFakeSandbox(
      sendAll(
        ids.map((n) => {
          return request(n, "slow", [n]);
        }),
      ),
    );
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

    expect(peak).toBe(8);
    expect(executed.filter((id) => id.includes(":wait:"))).toEqual([
      "exec:wait:1",
    ]);
    expect(
      replies(fake).map((reply) => (reply as { result: number }).result),
    ).toEqual(ids.map((n) => n * 2));
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

    fake.failUploads = 1;

    await run(host, { sendSlack });

    expect(sendSlack).toHaveBeenCalledTimes(1);
    expect(attempts.get("exec:wait:1")).toBe(2);
    expect(
      executed.filter((id) => id === "exec:tool:sendSlack:1"),
    ).toHaveLength(1);
    expect(fake.uploads).toHaveLength(1);
  });

  test("replay serves memoized steps without touching the sandbox or tools", async () => {
    const script: Fake["react"] = (f, replied) => {
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

    await run(createHost(createFakeSandbox(script).sandbox, memo).host, {
      sendSlack,
    });

    const replay = createFakeSandbox(script);
    const result = await run(createHost(replay.sandbox, memo).host, {
      sendSlack,
    });

    expect(sendSlack).toHaveBeenCalledTimes(1);
    expect(replay.fake.started).toBe(0);
    expect(replay.fake.uploads).toEqual([]);
    expect(result).toMatchObject({ result: { exitCode: 0 } });
  });

  test.each([
    {
      name: "the call cap",
      options: { maxCalls: 2 },
      timeoutMs: undefined,
      message: "more than 2 tool calls",
    },
    {
      name: "the wall-clock timeout",
      options: { waitWindow: 10 },
      timeoutMs: 1,
      message: "exceeded its 1ms timeout",
    },
  ])(
    "kills the process and throws past $name",
    async ({ options, timeoutMs, message }) => {
      const { fake, sandbox } = createFakeSandbox((f, replied) => {
        if (replied === undefined) {
          f.log += request(1, "t") + request(2, "t") + request(3, "t");
        }
      });
      const { host, executed } = createHost(sandbox);

      await expect(
        run(host, { t: async () => 1 }, options, timeoutMs),
      ).rejects.toThrow(message);

      expect(executed).toContain("exec:abort");
      expect(fake.killed).toBe(true);
    },
  );

  test("a quiet stretch continues in a fresh wait step", async () => {
    const { fake, sandbox } = createFakeSandbox(() => undefined);
    const { host, executed } = createHost(sandbox);
    const wait = sandbox.commands.run.bind(sandbox.commands);

    sandbox.commands.run = async (command, options) => {
      if (fake.waits.length === 2) {
        exitWith(fake);
      }

      return wait(command, options);
    };

    await run(host, {});

    expect(executed).toEqual(["exec", "exec:wait:1", "exec:wait:2"]);
  });

  test.each([['x"; import os #'], ["then"], ["_private"]])(
    "rejects the tool name %s before starting anything",
    async (name) => {
      const { fake, sandbox } = createFakeSandbox(() => undefined);
      const { host } = createHost(sandbox);

      await expect(
        run(host, { [name]: async () => undefined }),
      ).rejects.toThrow("Invalid tool name");
      expect(fake.started).toBe(0);
    },
  );

  test("does not retry a start step that failed after the process began", async () => {
    const { sandbox } = createFakeSandbox(() => undefined);
    const { host } = createHost(sandbox);

    (sandbox.commands as { run: unknown }).run = async () => {
      throw new Error("waiter blew up");
    };

    await expect(run(host, {})).rejects.toBeInstanceOf(NonRetriableError);
  });
});

describe("commands.run with tools trace group", () => {
  const inExecution = <T>(fn: () => T): T => {
    return runWithAsyncCtx({ app: {} as never, execution: {} as never }, fn);
  };

  test.each([
    {
      command: ["/bin/sh", "-c", "python3 x.py"],
      kind: "python",
      wait: "Python running…",
    },
    {
      command: ["/usr/bin/python3.12", "x.py"],
      kind: "python",
      wait: "Python running…",
    },
    {
      command: ["/bin/sh", "-c", "node a.js"],
      kind: "typescript",
      wait: "TypeScript running…",
    },
    {
      command: ["bun", "run", "x.ts"],
      kind: "typescript",
      wait: "TypeScript running…",
    },
    {
      command: ["/usr/bin/python3", "-c", "import os"],
      kind: "python",
      wait: "Python running…",
    },
    {
      command: ["/bin/sh", "-c", "ls -la"],
      kind: "sh",
      wait: "Waiting for tool calls",
    },
    { command: ["bash", "x.sh"], kind: "sh", wait: "Waiting for tool calls" },
  ])("$command runs in a $kind group", async ({ command, kind, wait }) => {
    const { sandbox } = createFakeSandbox(sendAll([request(1, "getCustomer")]));
    const { host, spans, names } = createHost(sandbox);

    await inExecution(() => {
      return runCommandWithTools(
        host,
        { id: "exec", name: "Analyse" },
        operation(300_000, command),
        {
          tools: { getCustomer: async () => ({ id: "cus_1" }) },
          toolOptions: { waitWindow: 5 },
        },
      );
    });

    expect(spans.get("exec")).toEqual([{ id: "exec", name: "Analyse", kind }]);
    expect(names.get("exec:wait:1")).toBe(wait);
  });

  test("tool calls are tool rows in the group, and waits stay in the group", async () => {
    const { sandbox } = createFakeSandbox(sendAll([request(1, "getCustomer")]));
    const { host, spans } = createHost(sandbox);

    await inExecution(() => {
      return run(host, { getCustomer: async () => ({ id: "cus_1" }) });
    });

    const group = { id: "exec", name: "exec", kind: "python" };
    expect(Object.fromEntries(spans)).toEqual({
      exec: [group],
      "exec:tool:getCustomer:1": [
        group,
        { id: "exec:tool:getCustomer:1", name: "getCustomer", kind: "tool" },
      ],
      "exec:wait:1": [group],
    });
  });

  test("a runner's group of the same kind holds the steps, without another", async () => {
    const { sandbox } = createFakeSandbox(sendAll([request(1, "getCustomer")]));
    const { host, spans } = createHost(sandbox);

    await inExecution(() => {
      return withSpan({ id: "runner", kind: "python" }, () => {
        return runCommandWithTools(
          host,
          "exec",
          operation(300_000, ["python3", "-c", "x"]),
          {
            tools: { getCustomer: async () => ({ id: "cus_1" }) },
            toolOptions: { waitWindow: 5 },
          },
        );
      });
    });

    const group = { id: "runner", name: "runner", kind: "python" };
    expect(spans.get("exec:wait:1")).toEqual([group]);
    expect(spans.get("exec:tool:getCustomer:1")).toEqual([
      group,
      { id: "exec:tool:getCustomer:1", name: "getCustomer", kind: "tool" },
    ]);
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

  test.each([
    { name: "without tools", options: undefined, tools: undefined },
    {
      name: "with tools, and a 5m default timeout",
      options: { tools: { a: async () => 1 } },
      tools: { tools: { a: expect.any(Function) }, toolOptions: undefined },
    },
  ])("$name it is one raw tool call", async ({ options, tools }) => {
    let span: unknown;
    const rawTool: SandboxRawTool = vi.fn(async () => {
      span = getAsyncCtxSync()?.execution?.span;

      return execResult;
    });
    const sandbox = createDurableSandboxFacade(sandboxRef, () => {
      return rawTool;
    });

    await runWithAsyncCtx({ app: {} as never, execution: {} as never }, () => {
      return sandbox.commands.run("exec", "true", options);
    });

    expect(span).toBeUndefined();

    expect(rawTool).toHaveBeenCalledExactlyOnceWith(
      "exec",
      expect.objectContaining({
        input: [
          expect.objectContaining({ timeoutMs: tools ? 300_000 : 30_000 }),
        ],
      }),
      tools,
      undefined,
    );
  });
});
