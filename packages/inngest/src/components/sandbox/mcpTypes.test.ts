/**
 * @module
 * Type tests for `tool.mcp()`: the handle goes in `agent.loop()` tools, and
 * its tools come out as a plain record.
 */
import { expectTypeOf } from "vitest";
import { agent } from "../agent/loop.ts";
import type { McpAuth, McpServer } from "./mcp.ts";
import { secret } from "./secret.ts";
import { type SandboxTools, tool } from "./tools.ts";

const hex = tool.mcp({
  url: "https://app.hex.tech/mcp",
  auth: { bearer: secret("HEX_TOKEN") },
  tools: ["create_thread"],
  timeout: "2m",
});

describe("tool.mcp types", () => {
  test("returns a handle, and tools() a plain record", async () => {
    expectTypeOf(hex).toEqualTypeOf<McpServer>();
    expectTypeOf(hex.tools()).resolves.toEqualTypeOf<SandboxTools>();
  });

  test("the handle goes in agent.loop() tools next to other tools", () => {
    const plain = tool.step({ run: () => 1 });

    expectTypeOf(agent.loop<{ hex: McpServer; plain: typeof plain }>)
      .parameter(0)
      .toHaveProperty("tools");
  });

  test("auth takes a bearer or headers, each a string or a secret", () => {
    expectTypeOf({ bearer: "t" }).toExtend<McpAuth>();
    expectTypeOf({ bearer: secret("A") }).toExtend<McpAuth>();
    expectTypeOf({ headers: { "x-key": secret("A") } }).toExtend<McpAuth>();
    expectTypeOf({ query: "t" }).not.toExtend<McpAuth>();
  });
});
