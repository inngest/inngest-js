import { describe, expect, test } from "vitest";
import { z } from "zod/v4";
import { Inngest } from "../../../components/Inngest.ts";
import { tool } from "../../../components/sandbox/tools.ts";
import { createAgents } from "../agent/agents.ts";
import { cardsOf } from "./discovery.ts";
import { matchesDiscovery } from "./match.ts";

describe("shared tools", () => {
  test("an app of only shared tools serves them and announces their cards", () => {
    const client = new Inngest({ id: "shared-only" });
    const postToX = tool.shared({
      id: "post-to-x",
      input: z.object({ text: z.string() }),
      card: { description: "Posts to X", tags: ["social"], share: "team" },
      run: async ({ text }) => {
        return { posted: text };
      },
    });
    const agents = createAgents(client, { tools: [postToX] });
    const ids = agents.functions().map((fn) => {
      return fn.id();
    });

    expect(ids).toContain("post-to-x");
    expect(ids).toContain("agents-announce");
    expect(cardsOf("shared-only")).toMatchObject([
      {
        kind: "tool",
        address: "shared-only/post-to-x",
        description: "Posts to X",
        share: "team",
        effects: "write",
      },
    ]);
  });

  test("a hosted shared tool has an address that discovery.tools can name", () => {
    const client = new Inngest({ id: "shared-addr" });
    const echo = tool.shared({
      id: "echo",
      input: z.object({ msg: z.string() }),
      run: async ({ msg }) => msg,
    });

    expect(() => echo.address).toThrow(/createAgents/);
    createAgents(client, { tools: [echo] });
    expect(echo.address).toBe("shared-addr/echo");
    expect(
      matchesDiscovery({ address: echo.address, effects: "write" }, [echo], {
        appId: "other",
      }),
    ).toBe(true);
  });
});
