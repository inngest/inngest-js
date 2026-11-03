/**
 * @module
 * Type tests for MCP servers as tools: the record `tools()` gives, the names a
 * loop result shows, and the surface of `tool.mcp()`.
 */

import { z } from "zod/v4";
import { disconnect } from "../../../components/sandbox/mcp.ts";
import { secret } from "../../../components/sandbox/secret.ts";
import {
  type SandboxTool,
  type SandboxToolContext,
  type SandboxTools,
  type ToolErrorResult,
  tool,
  toolDefinitions,
} from "../../../components/sandbox/tools.ts";
import * as entry from "../index.ts";
import { agent } from "../loop/loop.ts";
import { model, runLoop } from "../loop/loopKit.ts";
import { toolNamespaceSeparator } from "../sandboxes/defs.ts";
import { typesOnly } from "./typeFixtures.ts";

describe("tools types", () => {
  test("tools: an MCP server gives a record of tools with JSON object input", () => {
    typesOnly(async () => {
      const hex = tool.mcp({
        id: "hex",
        url: "https://mcp.example.com/mcp",
        auth: { bearer: secret("HEX_TOKEN") },
      });
      const listed = await hex.tools();

      expectTypeOf(hex.id).toBeString();
      expectTypeOf(await hex.disconnect("user-1")).toBeVoid();
      expectTypeOf(await disconnect(hex, "user-1")).toBeVoid();

      // tools() gives the same plain record of tools as a hand-written one.
      expectTypeOf(listed).toEqualTypeOf<SandboxTools>();

      // @ts-expect-error the id names the server's tokens, so it is required
      tool.mcp({ url: "https://mcp.example.com/mcp" });
    });
  });

  test("tools: an MCP server's calls are named key_tool in a loop result", () => {
    typesOnly(async () => {
      const result = await runLoop({
        model: async () => {
          return {
            message: { role: "assistant", content: "" },
            toolCalls: [],
          };
        },
        prompt: "go",
        tools: {
          hex: tool.mcp({ id: "hex", url: "https://mcp.example.com/mcp" }),
        },
      });
      type Run = Extract<(typeof result.toolCalls)[number], { isError: false }>;

      expectTypeOf<Run["name"]>().toEqualTypeOf<`hex_${string}`>();
      // Deliberate unknown: a remote server's tools are not known until it is
      // listed, so their input is JSON and their output is unknown.
      expectTypeOf<Run["call"]["input"]>().toEqualTypeOf<
        Record<string, unknown>
      >();
      expectTypeOf<Run["output"]>().toEqualTypeOf<unknown>();
      expectTypeOf<"hex_create_thread">().toExtend<Run["name"]>();

      // The bare key is not a name the model ever uses.
      expectTypeOf<"hex">().not.toExtend<Run["name"]>();
    });
  });

  test("the removed sign-in names are not exports", async () => {
    const experimental = await import("../../../experimental.ts");

    // @ts-expect-error waitForMcpAuthorization is internal now
    expect(experimental.waitForMcpAuthorization).toBeUndefined();
    // @ts-expect-error isMcpNeedsAuthorization is internal now
    expect(experimental.isMcpNeedsAuthorization).toBeUndefined();
    // @ts-expect-error mcpCallback replaces completeMcpAuthorization
    expect(experimental.completeMcpAuthorization).toBeUndefined();
    expect(experimental.mcpCallback).toBeTypeOf("function");
    expect(experimental.disconnect).toBeTypeOf("function");
  });

  test("onNeedsAuthorization takes { url, server, thread, user }", () => {
    typesOnly(() => {
      tool.mcp({
        id: "hex",
        url: "https://mcp.example.com/mcp",
        auth: {
          oauth: {
            user: ({ runId, event, thread }) => {
              expectTypeOf(runId).toEqualTypeOf<string | undefined>();
              expectTypeOf(event?.name).toEqualTypeOf<string | undefined>();
              expectTypeOf(thread?.key).toEqualTypeOf<string | undefined>();

              return "user-1";
            },
            redirectUri: "https://app.example.com/oauth/hex",
            onNeedsAuthorization: ({ url, server, thread, user }) => {
              expectTypeOf(url).toBeString();
              expectTypeOf(server).toBeString();
              expectTypeOf(thread).toEqualTypeOf<{ key: string } | undefined>();
              expectTypeOf(user).toBeString();
            },
          },
        },
      });
    });
  });

  test("tools: tool() types input and output from the schemas", () => {
    typesOnly(() => {
      const found = tool({
        id: "found",
        input: z.object({ id: z.string() }),
        output: z.object({ name: z.string() }),
        run: ({ id }) => {
          expectTypeOf(id).toBeString();

          return { name: id };
        },
      });

      expectTypeOf(found).toExtend<
        SandboxTool<{ id: string }, { name: string }>
      >();
    });
  });

  test("tools: tool() takes no id, the key in the tools record names it", () => {
    typesOnly(() => {
      const found = tool({
        description: "Find a thing",
        input: z.object({ slug: z.string() }),
        run: ({ slug }) => {
          return slug;
        },
      });
      const tools = { found } satisfies SandboxTools;

      expectTypeOf(tools).toExtend<SandboxTools>();
    });
  });

  test("tools: a tool with no output schema takes its output from run's return", () => {
    typesOnly(() => {
      const count = tool.step({
        input: z.object({ values: z.array(z.number()) }),
        run: async ({ values }) => {
          return { total: values.length, at: new Date(0) };
        },
      });

      // The output is the JSON the return comes back as: a Date is a string.
      expectTypeOf(count).toEqualTypeOf<
        SandboxTool<{ values: number[] }, { total: number; at: string }>
      >();
    });
  });

  test("tools: a run that does not match the output schema is an error", () => {
    typesOnly(() => {
      tool.step({
        input: z.object({ id: z.string() }),
        output: z.object({ name: z.string() }),
        // @ts-expect-error the return has no name
        run: () => {
          return { nope: 1 };
        },
      });
    });
  });

  test("tools: a toolError result is not part of the output type", () => {
    typesOnly(() => {
      const maybe = tool.step({
        input: z.object({ id: z.string() }),
        run: ({ id }) => {
          return id === "" ? agent.toolError("empty") : { id };
        },
      });

      expectTypeOf(maybe).toEqualTypeOf<
        SandboxTool<{ id: string }, { id: string }>
      >();
      expectTypeOf<ToolErrorResult>().not.toExtend<{ id: string }>();
    });
  });

  test("tools: a wrapped tool calls the original's run with typed arguments", () => {
    typesOnly(() => {
      const original = tool.step({
        input: z.object({ id: z.string() }),
        run: ({ id }) => {
          return { id, secret: "x" };
        },
      });
      const wrapped = tool.step({
        input: z.object({ id: z.string() }),
        run: async (input, ctx) => {
          const result = await (
            original.run as (
              input: { id: string },
              ctx: SandboxToolContext,
            ) => Promise<{ id: string; secret: string }>
          )(input, ctx);

          return { id: result.id };
        },
      });

      expectTypeOf(wrapped).toEqualTypeOf<
        SandboxTool<{ id: string }, { id: string }>
      >();
    });
  });

  test("tools: a tool's output is the JSON it comes back as", () => {
    typesOnly(() => {
      const dated = tool.step({
        run: () => {
          return { when: new Date(0), skip: undefined, n: 1 };
        },
      });

      expectTypeOf(dated).toEqualTypeOf<
        SandboxTool<Record<string, never>, { when: string; n: number }>
      >();
    });
  });

  test("tools: the tool context has a signal, an idempotency key, a run id and score", () => {
    expectTypeOf<SandboxToolContext["signal"]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<SandboxToolContext["idempotencyKey"]>().toBeString();
    expectTypeOf<SandboxToolContext["runId"]>().toBeString();
    expectTypeOf<SandboxToolContext["score"]>().toEqualTypeOf<
      (name: string, value: number | boolean) => Promise<void>
    >();
  });

  test("tools: untrusted is true or a function of the input that gives a label", () => {
    typesOnly(() => {
      tool.step({ untrusted: true, run: () => "x" });
      tool.step({
        input: z.object({ id: z.string() }),
        untrusted: ({ id }) => {
          expectTypeOf(id).toBeString();

          return `ticket ${id}`;
        },
        run: () => "x",
      });
      // @ts-expect-error false is not an option
      tool.step({ untrusted: false, run: () => "x" });
      tool.step({
        // @ts-expect-error the label is a string
        untrusted: () => 1,
        run: () => "x",
      });
    });
  });

  test("tools: waits needs a group", () => {
    typesOnly(() => {
      tool.group({ waits: true, run: () => "x" });
      // tool.step has no waits option
      // @ts-expect-error waits belongs to groups
      tool.step({ waits: true, run: () => "x" });
    });
  });

  test("tools: a tools record accepts every kind", () => {
    typesOnly(() => {
      const fn = async (input: { name: string }) => {
        return input.name.length;
      };
      const tools = {
        a: tool({ id: "a", run: () => "x" }),
        b: tool.step({ run: () => "x" }),
        c: tool.group({ run: () => "x" }),
        d: fn,
        e: tool.mcp({ id: "e", url: "https://mcp.example.com/mcp" }),
      } satisfies SandboxTools;

      expectTypeOf(tools).toExtend<SandboxTools>();
    });
  });

  test("tools: a plain function's input is its first parameter and its output its return", () => {
    typesOnly(async () => {
      const fn = async (input: { name: string }) => {
        return input.name.length;
      };
      const result = await runLoop({
        model: model(async () => {
          return {
            message: { role: "assistant", content: "" },
            toolCalls: [],
          };
        }),
        prompt: "go",
        tools: { fn },
      });
      type Run = Extract<(typeof result.toolCalls)[number], { isError: false }>;

      expectTypeOf<Run["call"]["input"]>().toEqualTypeOf<{ name: string }>();
      expectTypeOf<Run["output"]>().toEqualTypeOf<number>();
    });
  });

  test("tools: secret() is accepted wherever a token goes", () => {
    typesOnly(() => {
      tool.mcp({
        id: "hex",
        url: "https://mcp.example.com/mcp",
        auth: { bearer: secret("HEX_TOKEN") },
      });

      const auth: import("../sandboxes/repo.ts").RepoAuth = {
        read: secret("READ"),
        write: secret("WRITE"),
      };
      const one: import("../sandboxes/repo.ts").RepoAuth = secret("ONE");

      expectTypeOf(auth).not.toBeAny();
      expectTypeOf(one).not.toBeAny();
    });
  });

  test("tools: toolDefinitions and toolNamespaceSeparator stay", () => {
    expectTypeOf(toolDefinitions).toBeFunction();
    expectTypeOf(toolNamespaceSeparator).toBeString();
  });
});

test("tools: the removed names are not exported", () => {
  for (const name of [
    "slack",
    "github",
    "githubApp",
    "untrusted",
    "defineChannel",
    "askThrough",
  ]) {
    expect(Object.keys(entry)).not.toContain(name);
  }
});
