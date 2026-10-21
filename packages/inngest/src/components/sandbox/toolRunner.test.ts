/**
 * @module
 * Tests for tools on `commands.run`, using a fake sandbox that plays the part
 * of the stub and the waiter, and a fake step that memoizes like replay.
 */
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod/v3";
import type { StepOptions } from "../../types.ts";
import { getAsyncCtxSync, runWithAsyncCtx } from "../execution/als.ts";
import { referenceFunction } from "../InngestFunctionReference.ts";
import { step, withSpan } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { eventType } from "../triggers/triggers.ts";
import { createDurableSandboxFacade } from "./durable.ts";
import {
  parseSandboxOperationForAction,
  type SandboxRawTool,
} from "./protocol.ts";
import { createClient, runToEnd, sandboxResource } from "./test-helpers.ts";
import { runCommandWithTools, type ToolsHost } from "./toolRunner.ts";
import { type SandboxTools, tool } from "./tools.ts";
import { sdkOrigin } from "./trace.ts";
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
  return `${JSON.stringify({ op: "call", id, tool: name, args, ...(kwargs && { kwargs }) })}\n`;
};

const base64 = (text: string): string => {
  return Buffer.from(text).toString("base64");
};

interface Fake {
  /**
   * `ops.log`.
   */
  log: string;
  killed: boolean;

  /**
   * How many times the process was started, though its code runs only once.
   */
  started: number;

  /**
   * The command of the process that was started.
   */
  processCommand?: string[];
  waits: { lines: number; seconds: number }[];

  /**
   * Replies, as the lines the waiter was told to append.
   */
  replies: string[];

  /**
   * Files uploaded for replies too big for the waiter's command.
   */
  uploads: { path: string; body: string }[];
  failWaits: number;

  /**
   * Fails the first step's wait once.
   */
  failFirstWait: boolean;
  /**
   * Plays the sandbox code. Runs when the process starts and again each time
   * a reply lands, with the id of that reply.
   */
  react: (fake: Fake, replied: number | undefined) => void;
}

const exitWith = (fake: Fake, stdout = "done\n", code = 0): void => {
  fake.log += `${JSON.stringify({ op: "exit", code, stdout: base64(stdout), stderr: "" })}\n`;
};

const createFakeSandbox = (react: Fake["react"]) => {
  const fake: Fake = {
    log: "",
    killed: false,
    started: 0,
    waits: [],
    replies: [],
    uploads: [],
    failWaits: 0,
    failFirstWait: false,
    react,
  };
  const sandbox = {
    commands: {
      run: async (command: string[]) => {
        const [, , script, , , lines, seconds, ...replies] = command;

        if (script?.includes("kill -9")) {
          fake.killed = true;

          return { stdout: "", stderr: "", exitCode: 0 };
        }

        if (fake.failFirstWait && Number(lines) === 0) {
          fake.failFirstWait = false;

          throw new Error("wait failed");
        }

        if (fake.failWaits > 0 && replies.length > 0) {
          fake.failWaits--;

          throw new Error("wait failed");
        }

        for (const reply of replies) {
          const line = reply.startsWith("@")
            ? fake.uploads.find(({ path }) => {
                return path === reply.slice(1);
              })?.body
            : `${reply}\n`;

          fake.log += line;
          fake.replies.push(String(line).trim());
          fake.react(fake, JSON.parse(String(line)).id);
        }

        const news = fake.log.split("\n").slice(Number(lines), -1);
        fake.waits.push({ lines: Number(lines), seconds: Number(seconds) });

        return {
          stdout: news.map((line) => `${line}\n`).join(""),
          stderr: "",
          exitCode: 0,
        };
      },
    },
    files: {
      upload: async ({ path, data }: { path: string; data: unknown }) => {
        fake.uploads.push({ path, body: String(data) });

        return { path, bytesWritten: 0 };
      },
    },
    processes: {
      start: async ({ command }: { command: string[] }) => {
        // The wrapper exits at once when the directory is already claimed
        if (fake.started++ > 0) {
          return { id: "proc-2" };
        }

        fake.processCommand = command;
        fake.react(fake, undefined);

        return { id: "proc-1" };
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

    if (fake.replies.length === requests.length) {
      exitWith(fake);
    }
  };
};

/**
 * The replies the code received, by request ID.
 */
const replies = (fake: Fake): unknown[] => {
  return fake.replies
    .map((line) => {
      const { op: _op, ...reply } = JSON.parse(line);

      return reply;
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
    expect(fake.uploads).toEqual([]);
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
      name: "no arguments, checked as an empty set of named arguments",
      tools: {
        list: tool.step({
          input: z.object({ limit: z.number().default(10) }),
          run: async ({ limit }) => {
            return limit;
          },
        }),
      },
      requests: [request(1, "list")],
      replies: [{ id: 1, result: 10 }],
      steps: ["exec:tool:list:1"],
    },
    {
      name: "an input check that throws",
      tools: {
        flaky: tool.step({
          input: {
            "~standard": {
              version: 1,
              vendor: "test",
              validate: () => {
                throw new Error("schema service down");
              },
            },
          },
          run: vi.fn(),
        }),
      },
      requests: [request(1, "flaky", [], { a: 1 })],
      replies: [{ id: 1, error: "schema service down" }],
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
          // @ts-expect-error the body breaks its output schema on purpose
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
  test("many small replies together stay under the inline budget", async () => {
    const calls = Array.from({ length: 20 }, (_, index) => {
      return request(index + 1, "mid");
    });
    const { fake, sandbox } = createFakeSandbox(sendAll(calls));
    const { host } = createHost(sandbox);
    const wait = sandbox.commands.run.bind(sandbox.commands);
    const commands: string[][] = [];

    sandbox.commands.run = async (command, options) => {
      commands.push(command as string[]);

      return wait(command, options);
    };

    await run(host, {
      mid: async () => {
        return "x".repeat(2 * 1024);
      },
    });

    const inlineBytes = commands
      .flatMap((command) => {
        return command.slice(7);
      })
      .filter((reply) => {
        return !reply.startsWith("@");
      })
      .reduce((total, reply) => {
        return total + reply.length;
      }, 0);

    expect(inlineBytes).toBeLessThanOrEqual(24 * 1024);
    expect(fake.uploads.length).toBeGreaterThan(0);
    expect(fake.replies).toHaveLength(20);
  });

  test("waits are bounded by the time left on the command", async () => {
    const { fake, sandbox } = createFakeSandbox(() => undefined);
    const { host } = createHost(sandbox);
    const wait = sandbox.commands.run.bind(sandbox.commands);

    sandbox.commands.run = async (command, options) => {
      if (fake.waits.length === 1) {
        exitWith(fake);
      }

      return wait(command, options);
    };

    await run(host, {}, { waitWindow: 20_000 }, 2500);

    expect(fake.waits[0]?.seconds).toBe(3);
  });

  test("replies that don't fit the waiter's command go up as files", async () => {
    const { fake, sandbox } = createFakeSandbox(
      sendAll([request(1, "big", [1]), request(2, "big", [20])]),
    );
    const { host } = createHost(sandbox);
    const wait = sandbox.commands.run.bind(sandbox.commands);
    const commands: string[][] = [];

    sandbox.commands.run = async (command, options) => {
      commands.push(command as string[]);

      return wait(command, options);
    };

    await run(host, {
      big: async (kib: number) => {
        return "x".repeat(kib * 1024);
      },
    });

    const [answering] = commands.filter((command) => {
      return command.length > 7;
    });

    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]?.path).toMatch(/\/reply\.1$/);
    expect(answering).toHaveLength(9);
    expect(answering?.[7]).toContain('"op":"reply"');
    expect(answering?.[8]).toBe(`@${fake.uploads[0]?.path}`);
    expect(fake.replies).toHaveLength(2);
  });

  test("a failed wait retries without running the tool again", async () => {
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

    fake.failWaits = 1;

    await run(host, { sendSlack });

    expect(sendSlack).toHaveBeenCalledTimes(1);
    expect(attempts.get("exec:wait:1")).toBe(2);
    expect(
      executed.filter((id) => id === "exec:tool:sendSlack:1"),
    ).toHaveLength(1);
    expect(fake.replies).toHaveLength(1);
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
    expect(replay.fake.replies).toEqual([]);
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

  test("a retried first step runs the code once", async () => {
    const code = vi.fn();
    const { fake, sandbox } = createFakeSandbox((f, replied) => {
      if (replied === undefined) {
        code();
        exitWith(f);
      }
    });
    const { host, attempts } = createHost(sandbox);

    fake.failFirstWait = true;

    const result = await run(host, {});

    expect(attempts.get("exec")).toBe(2);
    expect(fake.started).toBe(2);
    expect(code).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ result: { exitCode: 0 } });
  });

  test("names the directory for the run and step, so a rerun finds it", async () => {
    const dirs = new Set<string | undefined>();

    for (const runId of ["run-1", "run-1", "run-2"]) {
      const { fake, sandbox } = createFakeSandbox((f, replied) => {
        if (replied === undefined) {
          exitWith(f);
        }
      });
      const { host } = createHost(sandbox);

      await run({ ...host, runId }, {});

      dirs.add(fake.processCommand?.[4]);
    }

    expect([...dirs]).toEqual([
      expect.stringMatching(/^\/inngest\/tools\/[0-9a-f]{64}$/),
      expect.stringMatching(/^\/inngest\/tools\/[0-9a-f]{64}$/),
    ]);
  });

  test("a repeated command ID gets its own directory", async () => {
    const dirs = new Set<string | undefined>();

    for (const stepId of ["hashed", "hashed:1"]) {
      const { fake, sandbox } = createFakeSandbox((f, replied) => {
        if (replied === undefined) {
          exitWith(f);
        }
      });
      const { host } = createHost(sandbox);
      const inStep: ToolsHost["run"] = (idOrOptions, fn, meta) => {
        return host.run(
          idOrOptions,
          () => {
            return runWithAsyncCtx(
              {
                app: {} as never,
                execution: { executingStep: { id: stepId } } as never,
              },
              fn,
            );
          },
          meta,
        );
      };

      await run({ ...host, run: inStep }, {});

      dirs.add(fake.processCommand?.[4]);
    }

    expect(dirs.size).toBe(2);
  });

  test("names the directory apart for each step ID prefix", async () => {
    const dirs = new Set<string | undefined>();

    for (const stepIdPrefix of [undefined, "a:", "b:"]) {
      const { fake, sandbox } = createFakeSandbox((f, replied) => {
        if (replied === undefined) {
          exitWith(f);
        }
      });
      const { host } = createHost(sandbox);

      await runWithAsyncCtx(
        {
          app: {} as never,
          execution: { ctx: {}, stepIdPrefix } as never,
        },
        () => {
          return run(host, {});
        },
      );

      dirs.add(fake.processCommand?.[4]);
    }

    expect(dirs.size).toBe(3);
  });
});

describe("tool.step", () => {
  test("types the body's input from the schema and its result from the output", () => {
    tool.step({
      input: z.object({ id: z.string() }),
      output: z.object({ n: z.number() }),
      run: ({ id }, ctx) => {
        expectTypeOf(id).toEqualTypeOf<string>();
        expectTypeOf(ctx.idempotencyKey).toEqualTypeOf<string>();

        return { n: id.length };
      },
    });
  });

  test("a body without an input schema is checked against the output", () => {
    tool.step({
      output: z.number(),
      // @ts-expect-error the body returns a string, not a number
      run: () => {
        return "nope";
      },
    });
  });
});

describe("commands.run with tools trace rows", () => {
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
  ])("$command waits as '$wait'", async ({ command, wait }) => {
    const { sandbox } = createFakeSandbox(sendAll([request(1, "getCustomer")]));
    const { host, names } = createHost(sandbox);

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

    expect(names.get("exec:wait:1")).toBe(wait);
  });

  test("tool calls are tool rows in the command's row, and waits stay in it", async () => {
    const { sandbox } = createFakeSandbox(sendAll([request(1, "getCustomer")]));
    const { host, spans } = createHost(sandbox);
    const group = { id: "exec", name: "exec", kind: "$" };

    await inExecution(() => {
      return withSpan(group, () => {
        return run(host, { getCustomer: async () => ({ id: "cus_1" }) });
      });
    });

    expect(Object.fromEntries(spans)).toEqual({
      exec: [group],
      "exec:tool:getCustomer:1": [
        group,
        {
          id: "exec:tool:getCustomer:1",
          name: "getCustomer",
          kind: "tool",
          origin: sdkOrigin,
        },
      ],
      "exec:wait:1": [group],
    });
  });

  test("a tool's displayName names its step and row", async () => {
    const { sandbox } = createFakeSandbox(sendAll([request(1, "getCustomer")]));
    const { host, spans } = createHost(sandbox);

    await inExecution(() => {
      return run(host, {
        getCustomer: tool.step({
          input: z.object({}),
          displayName: () => {
            return "Look up customer";
          },
          run: () => {
            return { id: "cus_1" };
          },
        }),
      });
    });

    expect(spans.get("exec:tool:getCustomer:1")).toEqual([
      expect.objectContaining({
        id: "exec:tool:getCustomer:1",
        name: "Look up customer",
        kind: "tool",
      }),
    ]);
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
      {
        id: "exec:tool:getCustomer:1",
        name: "getCustomer",
        kind: "tool",
        origin: sdkOrigin,
      },
    ]);
  });
});

describe("commands.run with tools that run steps", () => {
  const seen: {
    id: string;
    prefix?: string;
    tool?: string;
    data?: unknown;
  }[] = [];
  const fakeStep = {
    run: async (id: string, fn: () => unknown) => {
      seen.push({
        id,
        prefix: getAsyncCtxSync()?.execution?.stepIdPrefix,
        tool: getAsyncCtxSync()?.execution?.span?.at(-1)?.name,
      });

      return fn();
    },
    invoke: async (id: string, options: { data?: unknown }) => {
      seen.push({
        id,
        prefix: getAsyncCtxSync()?.execution?.stepIdPrefix,
        data: options.data,
      });

      return { refunded: true };
    },
  };

  const inFunction = <T>(fn: () => T): T => {
    seen.length = 0;

    return runWithAsyncCtx(
      {
        app: {} as never,
        execution: { ctx: { step: fakeStep } } as never,
      },
      fn,
    );
  };

  interface GroupCase {
    name: string;
    tool: SandboxTools[string];
    reply: unknown;
  }

  test.each<GroupCase>([
    {
      name: "runs real steps and returns their result",
      tool: tool.group({
        input: z.object({ orderId: z.string() }),
        run: async () => {
          return step.run("double", () => {
            return 4;
          });
        },
      }),
      reply: { result: 4 },
    },
    {
      name: "returns an invoke result to the sandbox",
      tool: tool.group({
        input: z.object({ orderId: z.string() }),
        run: async ({ orderId }) => {
          return step.invoke("refund", {
            function: referenceFunction({ functionId: "refund" }),
            data: { orderId },
          });
        },
      }),
      reply: { result: { refunded: true } },
    },
    {
      name: "turns a thrown error into a tool error",
      tool: tool.group({
        input: z.object({ orderId: z.string() }),
        run: async () => {
          await step.run("fail", () => {
            throw new Error("card declined");
          });
        },
      }),
      reply: { error: "card declined" },
    },
  ])("$name", async ({ tool: entry, reply }) => {
    const { fake, sandbox } = createFakeSandbox(
      sendAll([request(1, "refund", [], { orderId: "o_1" })]),
    );
    const { host, executed } = createHost(sandbox);

    await inFunction(() => {
      return run(host, { refund: entry });
    });

    expect(replies(fake)).toEqual([{ id: 1, ...(reply as object) }]);
    expect(executed).toEqual(["exec", "exec:wait:1"]);
  });

  describe("an Inngest function", () => {
    const refund = createClient(() => undefined).createFunction(
      {
        id: "refund",
        triggers: [
          eventType("order/refund", {
            schema: z.object({ orderId: z.string() }),
          }),
        ],
      },
      async () => {
        return { refunded: true };
      },
    );
    const wrapped = createClient(() => undefined).createFunction(
      {
        id: "wrapped",
        triggers: [
          {
            event: eventType("order/wrapped", {
              schema: z.object({ orderId: z.string() }),
            }),
          },
        ],
      },
      async () => {
        return { refunded: true };
      },
    );
    const untyped = createClient(() => undefined).createFunction(
      { id: "untyped", triggers: [{ event: "order/untyped" }] },
      async () => {
        return { refunded: true };
      },
    );

    interface FunctionCase {
      name: string;
      tool: SandboxTools[string];
      request: string;
      reply: unknown;
      invoked: unknown[];
    }

    test.each<FunctionCase>([
      {
        name: "is invoked with the named arguments as its data",
        tool: refund,
        request: request(1, "refund", [], { orderId: "o_1" }),
        reply: { result: { refunded: true } },
        invoked: [{ orderId: "o_1" }],
      },
      {
        name: "gets its data checked against its trigger's schema",
        tool: refund,
        request: request(1, "refund", [], { orderId: 5 }),
        reply: {
          error:
            "Invalid arguments for refund: orderId: Expected string, received number",
        },
        invoked: [],
      },
      {
        name: "gets its data checked against a schema on a wrapped event type",
        tool: wrapped,
        request: request(1, "refund", [], { orderId: 5 }),
        reply: {
          error:
            "Invalid arguments for refund: orderId: Expected string, received number",
        },
        invoked: [],
      },
      {
        name: "without a trigger schema takes any named arguments",
        tool: untyped,
        request: request(1, "refund", [], { anything: 1 }),
        reply: { result: { refunded: true } },
        invoked: [{ anything: 1 }],
      },
      {
        name: "without a trigger schema still takes one set of named arguments",
        tool: untyped,
        request: request(1, "refund", ["o_1", "o_2"]),
        reply: { error: "refund takes one set of named arguments" },
        invoked: [],
      },
      {
        name: "can be a reference to a function",
        tool: referenceFunction({ functionId: "refund" }),
        request: request(1, "refund", [], { orderId: "o_1" }),
        reply: { result: { refunded: true } },
        invoked: [{ orderId: "o_1" }],
      },
    ])("$name", async ({ tool: entry, request: sent, reply, invoked }) => {
      const { fake, sandbox } = createFakeSandbox(sendAll([sent]));
      const { host } = createHost(sandbox);

      await inFunction(() => {
        return run(host, { refund: entry });
      });

      expect(replies(fake)).toEqual([{ id: 1, ...(reply as object) }]);
      expect(seen).toEqual(
        invoked.map((data) => {
          return { id: "invoke", prefix: "exec:tool:refund:1:", data };
        }),
      );
    });
  });

  test("two calls of the same tool scope their steps apart", async () => {
    const { sandbox } = createFakeSandbox(
      sendAll([request(1, "lookup"), request(2, "lookup")]),
    );
    const { host } = createHost(sandbox);
    const lookup = tool.group({
      run: async () => {
        return step.run("find", () => {
          return "found";
        });
      },
    });

    await inFunction(() => {
      return run(host, { lookup });
    });

    expect(seen).toEqual([
      { id: "find", prefix: "exec:tool:lookup:1:", tool: "lookup" },
      { id: "find", prefix: "exec:tool:lookup:2:", tool: "lookup" },
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
    const rawTool: SandboxRawTool = vi.fn(async () => {
      return execResult;
    });
    const sandbox = createDurableSandboxFacade(sandboxRef, () => {
      return rawTool;
    });

    await sandbox.commands.run("exec", "true", options);

    expect(rawTool).toHaveBeenCalledExactlyOnceWith(
      "exec",
      expect.objectContaining({
        input: [
          expect.objectContaining({ timeoutMs: tools ? 300_000 : 30_000 }),
        ],
      }),
      ...(tools ? [undefined, tools] : []),
    );
  });
});

describe("a caller's span on a command with tools", () => {
  test("is around every step, not on the first", async () => {
    const callerSpan = { id: "mine", name: "Mine", kind: "job" };
    const seen: unknown[] = [];
    const rawTool: SandboxRawTool = vi.fn(async (idOrOptions) => {
      seen.push(idOrOptions, getAsyncCtxSync()?.execution?.span);

      return {
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
    });
    const sandbox = createDurableSandboxFacade(sandboxRef, () => {
      return rawTool;
    });

    await runWithAsyncCtx(
      { app: {} as never, execution: { instance: {} } as never },
      () => {
        return sandbox.commands.run(
          { id: "exec", "~span": callerSpan },
          "true",
          { tools: { a: async () => 1 } },
        );
      },
    );

    expect(seen).toEqual([
      expect.not.objectContaining({ "~span": expect.anything() }),
      [expect.objectContaining(callerSpan)],
    ]);
  });
});

describe("commands.run with tools in a function", () => {
  test("starts the command, follows it and returns its output", async () => {
    const wrapped: string[][] = [];
    const exit = JSON.stringify({
      op: "exit",
      code: 0,
      stdout: base64("hello\n"),
      stderr: "",
    });
    const client = createClient((path, method, { body }) => {
      if (path === "/v2/sandboxes" && method === "POST") {
        return Response.json({ data: sandboxResource }, { status: 201 });
      }

      if (path.endsWith("/processes") && method === "POST") {
        wrapped.push((body ? JSON.parse(String(body)) : {}).command);

        return Response.json(
          {
            data: {
              id: "33333333-3333-4333-8333-333333333333",
              command: ["sh"],
              pid: 1,
              state: "RUNNING",
            },
          },
          { status: 201 },
        );
      }

      if (path.endsWith("/exec")) {
        return Response.json({
          data: {
            stdout: base64(`${exit}\n`),
            stderr: "",
            encoding: "base64",
            exitCode: 0,
          },
        });
      }

      return undefined;
    });
    let stdout = "";
    const fn = client.createFunction(
      { id: "tools", triggers: [{ event: "tools/run" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.create("box", {
          name: "box",
          vcpu: 1,
          memoryMb: 512,
        });
        const result = await sandbox.commands.run("hello", "echo hello", {
          tools: { a: async () => 1 },
        });

        stdout = result.stdout;
      },
    );

    const { ran } = await runToEnd(fn);

    expect(ran).toEqual(["box", "hello"]);
    expect(wrapped).toHaveLength(1);
    expect(stdout).toBe("hello\n");
  });
});
