/**
 * @module
 * `tool.mcp()` against a fake MCP server on localhost: the tool list is one
 * step, the model's calls are steps that reach the server with the bearer, a
 * replay never repeats a call, and a connection that drops after the request
 * was sent comes back to the model as an unknown outcome instead of a retry.
 * The credential appears in no run output, tool result or history.
 */
import { secret, tool } from "inngest/experimental";
import { agent } from "inngest/experimental/agents";
import { fakeMcpServer } from "inngest/experimental/agents/testing";
import { scenario, script } from "../kit/driver.ts";

const token = "e2e-mcp-token-0123456789";

process.env.E2E_MCP_TOKEN = token;

// One server for the app process, started by the first function that needs it.
let started: ReturnType<typeof fakeMcpServer> | undefined;
let armed = false;

const server = () => {
  started ??= fakeMcpServer({
    token,
    tools: {
      create_thread: {
        description: "Starts a thread",
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string" } },
        },
        run: (args) => {
          return { id: "t-1", prompt: args.prompt };
        },
      },
      get_thread: {
        description: "Reads a thread",
        annotations: { readOnlyHint: true },
        run: () => {
          return { id: "t-1", status: "DONE" };
        },
      },
    },
  });

  return started;
};

export const toolMcp = scenario({
  id: "tool-mcp",
  owner: "agents-tool-mcp",
  functions: ({ client, event }) => {
    const analyst = async (drop: boolean) => {
      const fake = await server();
      const hex = tool.mcp({
        url: fake.url,
        auth: { bearer: secret("E2E_MCP_TOKEN") },
      });

      // The function body runs again for every step: arm the drop once.
      if (drop && !armed) {
        armed = true;
        fake.dropNext(1);
      }

      const result = await agent.loop({
        model: script([
          { call: { name: "hex_create_thread", input: { prompt: "hi" } } },
          { call: { name: "hex_get_thread", input: { id: "t-1" } } },
          { say: "done" },
        ]),
        prompt: "go",
        tools: { hex },
      });

      return {
        text: result.text,
        outputs: result.toolCalls.map((run) => {
          return { name: run.name, isError: run.isError };
        }),
        unknownOutcome: JSON.stringify(result.history).includes(
          "Outcome unknown",
        ),
        leaked: JSON.stringify(result).includes(token),
        creates: fake.calls.filter((call) => {
          return call.method === "tools/call" && call.tool === "create_thread";
        }).length,
        bearerOnEveryRequest: fake.calls.every((call) => {
          return call.headers.authorization === `Bearer ${token}`;
        }),
      };
    };

    return [
      client.createFunction(
        { id: "tool-mcp-ok", triggers: [{ event: event("ok") }] },
        () => {
          return analyst(false);
        },
      ),
      client.createFunction(
        { id: "tool-mcp-drop", triggers: [{ event: event("drop") }] },
        () => {
          return analyst(true);
        },
      ),
    ];
  },
  run: async (ctx) => {
    const ok = await ctx.finished(
      await ctx.send("ok", {}, { startsRun: true }),
    );

    ctx.expect.run(ok).toComplete();
    ctx.expect
      .run(ok)
      .toHaveSteps(
        "agent:mcp:hex:list",
        "agent:model:1",
        "agent:1.0:hex_create_thread",
        "agent:model:2",
        "agent:2.0:hex_get_thread",
        "agent:model:3",
      );
    ctx.expect.run(ok).toOutput({
      text: "done",
      outputs: [
        { name: "hex_create_thread", isError: false },
        { name: "hex_get_thread", isError: false },
      ],
      unknownOutcome: false,
      leaked: false,
      creates: 1,
      bearerOnEveryRequest: true,
    });

    const dropped = await ctx.finished(
      await ctx.send("drop", {}, { startsRun: true }),
    );

    ctx.expect.run(dropped).toComplete();
    ctx.expect.run(dropped).toOutput({
      text: "done",
      outputs: [
        { name: "hex_create_thread", isError: true },
        { name: "hex_get_thread", isError: false },
      ],
      unknownOutcome: true,
      leaked: false,
      creates: 2,
      bearerOnEveryRequest: true,
    });
  },
});
