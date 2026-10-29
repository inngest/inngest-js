/**
 * @module
 * Tests for `tool.mcp()`: the client, the handle, and the loop with a fake
 * MCP server.
 */
import { describe, expect, test } from "vitest";
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import type { OutgoingOp } from "../../types.ts";
import { type AgentModelRequest, agent } from "../agent/loop.ts";
import { fakeMcpFetch } from "../agent/testing/mcp.ts";
import { script } from "../agent/testing/model.ts";
import { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { McpAuthError, McpUnavailableError } from "./mcpClient.ts";
import { secret } from "./secret.ts";
import { resolveToolCall, type SandboxTool, tool } from "./tools.ts";

const token = "hex-token-0123456789";

const threads = {
  create_thread: {
    description: "Starts a thread",
    inputSchema: {
      type: "object" as const,
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
    run: (args: Record<string, unknown>) => {
      return { id: "t-1", prompt: args.prompt };
    },
  },
  "get-thread": {
    description: "Reads a thread",
    annotations: { readOnlyHint: true },
    run: () => {
      return "running";
    },
  },
};

const connect = (
  options: Partial<Parameters<typeof tool.mcp>[0]> = {},
  server = fakeMcpFetch({ tools: threads, token }),
) => {
  const hex = tool.mcp({
    id: "hex",
    url: server.url,
    fetch: server.fetch,
    auth: { bearer: secret("MCP_TEST_TOKEN") },
    ...options,
  });

  return { hex, server };
};

const build = async (hex: ReturnType<typeof tool.mcp>, name = "hex") => {
  return hex["~build"](name, await hex["~list"]());
};

const context = (signal = new AbortController().signal) => {
  return { signal, idempotencyKey: "key-1" };
};

const call = async (entry: unknown, input: unknown) => {
  const run = (entry as SandboxTool).run as (...args: unknown[]) => unknown;

  return run(input, context());
};

describe("tool.mcp", () => {
  process.env.MCP_TEST_TOKEN = token;

  test("lists the server's tools as <name>_<tool> with their schemas", async () => {
    const { hex } = connect();
    const tools = await build(hex);

    expect(Object.keys(tools)).toEqual(["hex_create_thread", "hex_get_thread"]);
    expect(tools.hex_create_thread).toMatchObject({
      description: "Starts a thread",
      input: { type: "object", required: ["prompt"] },
    });
  });

  test("sends the bearer on every request, and the idempotency key", async () => {
    const { hex, server } = connect();
    const tools = await build(hex);

    expect(await call(tools.hex_create_thread, { prompt: "hi" })).toEqual({
      id: "t-1",
      prompt: "hi",
    });
    expect(server.calls.map((item) => item.method)).toContain("initialize");
    expect(
      server.calls.every((item) => {
        return item.headers.authorization === `Bearer ${token}`;
      }),
    ).toBe(true);
    expect(server.calls.at(-1)).toMatchObject({
      method: "tools/call",
      tool: "create_thread",
      args: { prompt: "hi" },
      meta: { "inngest/idempotencyKey": "key-1" },
    });
  });

  test("the listing and every result are free of the credential", async () => {
    const { hex } = connect();
    const listing = await hex["~list"]();
    const tools = await build(hex);
    const output = await call(tools.hex_get_thread, {});

    expect(JSON.stringify(listing)).not.toContain(token);
    expect(JSON.stringify(output)).not.toContain(token);
    expect(JSON.stringify(hex)).not.toContain(token);
    expect(String(secret("MCP_TEST_TOKEN"))).not.toContain(token);
    expect(JSON.stringify({ auth: secret("MCP_TEST_TOKEN") })).not.toContain(
      token,
    );
  });

  test("redacts a credential the server echoes back", async () => {
    const { hex } = connect(
      {},
      fakeMcpFetch({
        tools: {
          echo: {
            run: () => {
              return `your token is ${token}`;
            },
          },
        },
      }),
    );
    const tools = await build(hex);

    expect(await call(tools.hex_echo, {})).toBe("your token is [redacted]");
  });

  test("an allowlist limits the tools, and a name the server lacks throws", async () => {
    const { hex } = connect({ tools: ["get-thread"] });

    expect(Object.keys(await build(hex))).toEqual(["hex_get_thread"]);
    expect(build(connect({ tools: ["nope"] }).hex)).rejects.toThrow(
      'has no tool "nope"',
    );
  });

  test("two names that collide once - becomes _ throw", async () => {
    const { hex } = connect(
      {},
      fakeMcpFetch({
        tools: {
          "a-b": { run: () => "1" },
          a_b: { run: () => "2" },
        },
      }),
    );

    await expect(build(hex)).rejects.toThrow('are named "hex_a_b"');
  });

  test("an isError result is a tool error", async () => {
    const { hex } = connect(
      {},
      fakeMcpFetch({
        tools: {
          boom: {
            run: () => {
              throw new Error("no such thread");
            },
          },
        },
        token,
      }),
    );
    const tools = await build(hex);

    expect(await call(tools.hex_boom, {})).toEqual({
      "~error": "no such thread",
    });
  });

  test("an event stream answer is read", async () => {
    const { hex } = connect(
      {},
      fakeMcpFetch({ tools: threads, token, stream: true }),
    );
    const tools = await build(hex);

    expect(await call(tools.hex_get_thread, {})).toBe("running");
  });

  test("a long result keeps its start and end", async () => {
    const { hex } = connect(
      {},
      fakeMcpFetch({
        tools: {
          big: {
            run: () => {
              return `start${"x".repeat(400_000)}end`;
            },
          },
        },
        token,
      }),
    );
    const tools = await build(hex);
    const output = (await call(tools.hex_big, {})) as string;

    expect(output.startsWith("start")).toBe(true);
    expect(output.endsWith("end")).toBe(true);
    expect(output).toContain("[truncated ");
    expect(output.length).toBeLessThan(300_000);
  });

  test("a dropped connection after sending is an unknown outcome, not a retry", async () => {
    const { hex, server } = connect();
    const tools = await build(hex);

    server.dropNext(1);

    expect(await call(tools.hex_create_thread, { prompt: "hi" })).toEqual({
      "~error": expect.stringContaining("Outcome unknown"),
    });
    expect(
      server.calls.filter((item) => item.method === "tools/call"),
    ).toHaveLength(1);
  });

  test("a read-only tool retries when the outcome is unknown", async () => {
    const { hex, server } = connect();
    const tools = await build(hex);

    server.dropNext(1);

    await expect(call(tools.hex_get_thread, {})).rejects.toThrow(
      "connection to the MCP server failed",
    );
  });

  test("503 is safe to retry, so it throws for the step to retry", async () => {
    const { hex, server } = connect();
    const tools = await build(hex);

    server.failNext(1, 503);

    await expect(
      call(tools.hex_create_thread, { prompt: "hi" }),
    ).rejects.toBeInstanceOf(McpUnavailableError);
  });

  test("an OAuth-only server fails fast with a message that says what to do", async () => {
    const { hex, server } = connect();

    server.oauthOnly();

    await expect(hex["~list"]()).rejects.toBeInstanceOf(McpAuthError);
    await expect(hex["~list"]()).rejects.toThrow("auth: { bearer: secret(");
  });

  test("a wrong token is an auth error that names no credential", async () => {
    process.env.MCP_TEST_WRONG = "wrong-token-value";

    const { hex } = connect({ auth: { bearer: secret("MCP_TEST_WRONG") } });
    const error = await hex["~list"]().catch((caught) => caught);

    expect(error).toBeInstanceOf(McpAuthError);
    expect(error.message).not.toContain("wrong-token-value");
  });

  test("a missing secret fails without retrying", async () => {
    const { hex } = connect({ auth: { bearer: secret("MCP_TEST_UNSET") } });

    await expect(hex["~list"]()).rejects.toMatchObject({
      name: "SecretMissingError",
    });
  });

  test("a session the server dropped starts again", async () => {
    const { hex, server } = connect();
    const tools = await build(hex);

    server.expireSessions();

    expect(await call(tools.hex_get_thread, {})).toBe("running");
  });

  test("refuses plain http except for localhost, and credentials in the url", () => {
    expect(() => tool.mcp({ url: "http://example.com/mcp" })).toThrow("https");
    expect(() => tool.mcp({ url: "http://localhost:1/mcp" })).not.toThrow();
    expect(() => tool.mcp({ url: "https://u:p@example.com/mcp" })).toThrow(
      "credentials",
    );
  });

  test("a server in a plain tools record fails with a pointer to tools()", async () => {
    const { hex } = connect();

    const { toolDefinitions } = await import("./tools.ts");

    expect(() => toolDefinitions({ hex })).toThrow("await server.tools()");
  });

  test("sandbox code calls the tools by name with named arguments, and a tool error is an error", async () => {
    const { hex } = connect();
    const tools = await build(hex);
    const resolved = await resolveToolCall(
      tools,
      {
        op: "call",
        id: 1,
        tool: "hex_create_thread",
        args: [],
        kwargs: { prompt: "hi" },
      },
      "{}",
    );

    if (resolved.error !== undefined) {
      throw new Error(resolved.error);
    }

    expect(await resolved.invoke(context())).toEqual({
      id: "t-1",
      prompt: "hi",
    });
  });

  test("tools() needs a name", async () => {
    const hex = tool.mcp({ url: "https://example.com/mcp" });

    await expect(hex.tools()).rejects.toThrow("needs a name");
  });
});

/**
 * Plays the executor for a function: runs it until it resolves, running the
 * steps it finds one at a time.
 */
const drive = async (fn: InngestFunction.Any) => {
  const ran: string[] = [];
  const outputs: Record<string, unknown> = {};
  let state: Parameters<typeof runFnWithStack>[1] = {};

  for (let request = 0; request < 40; request++) {
    const result = await runFnWithStack(fn, state);

    if (result.type !== "steps-found" && result.type !== "step-ran") {
      return { type: result.type, ran, outputs };
    }

    const found = result.type === "step-ran" ? [result.step] : result.steps;

    for (const op of found) {
      const { step: done } =
        result.type === "step-ran"
          ? result
          : ((await runFnWithStack(fn, state, { runStep: op.id })) as {
              step: OutgoingOp;
            });

      ran.push(done.userland?.id ?? done.id);
      outputs[done.userland?.id ?? done.id] = done.data;
      state = {
        ...state,
        [done.id]: done.error
          ? { id: done.id, error: done.error }
          : { id: done.id, data: done.data },
      };
    }
  }

  throw new Error("The function did not finish");
};

describe("tool.mcp in agent.loop", () => {
  process.env.MCP_TEST_TOKEN = token;

  test("the model sees namespaced tools, the list is one step, and calls are steps", async () => {
    const { hex, server } = connect();
    const requests: AgentModelRequest[] = [];
    const client = new Inngest({ id: testClientId });
    const model = script([
      { call: { name: "hex_create_thread", input: { prompt: "hi" } } },
      { say: "done" },
    ]);
    let text = "";
    const fn = client.createFunction(
      { id: "mcp-loop", triggers: [{ event: "mcp/run" }] },
      async () => {
        const result = await agent.loop({
          model: agent.model(async (request) => {
            requests.push(structuredClone(request));

            return model(request);
          }),
          prompt: "go",
          tools: { hex },
        });

        text = result.text;
      },
    );
    const { type, ran, outputs } = await drive(fn);

    expect(type).toBe("function-resolved");
    expect(ran).toEqual([
      "agent:mcp:hex:list",
      "agent:model:1",
      "agent:1.0:hex_create_thread",
      "agent:model:2",
    ]);
    expect(requests[0]?.tools.map((item) => item.name)).toEqual([
      "hex_create_thread",
      "hex_get_thread",
    ]);
    expect(outputs["agent:1.0:hex_create_thread"]).toEqual({
      id: "t-1",
      prompt: "hi",
    });
    expect(text).toBe("done");
    expect(JSON.stringify(outputs)).not.toContain(token);
    expect(
      server.calls
        .filter((item) => item.method === "tools/call")
        .map((item) => item.tool),
    ).toEqual(["create_thread"]);
  });

  test("an unknown outcome reaches the model as an error result", async () => {
    const { hex, server } = connect();
    const requests: AgentModelRequest[] = [];
    const client = new Inngest({ id: testClientId });
    const model = script([
      { call: { name: "hex_create_thread", input: { prompt: "hi" } } },
      { say: "checked" },
    ]);
    const fn = client.createFunction(
      { id: "mcp-unknown", triggers: [{ event: "mcp/run" }] },
      async () => {
        await agent.loop({
          model: agent.model(async (request) => {
            requests.push(structuredClone(request));

            return model(request);
          }),
          prompt: "go",
          tools: { hex },
        });
      },
    );

    server.dropNext(1);

    await drive(fn);

    expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain(
      "Outcome unknown",
    );
  });
});
