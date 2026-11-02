/**
 * @module
 * Type tests for MCP servers as tools: the record `tools()` gives, the names a
 * loop result shows, and the surface of `tool.mcp()`.
 */
import { disconnect } from "../../../components/sandbox/mcp.ts";
import { secret } from "../../../components/sandbox/secret.ts";
import { type SandboxTools, tool } from "../../../components/sandbox/tools.ts";
import { agent } from "../loop/loop.ts";
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
      const result = await agent.loop({
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
});
