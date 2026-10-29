/**
 * @module
 * Tests for agents used as tools: their definitions, the invoke they make, and
 * how `mayCall` treats them.
 */
import { z } from "zod/v4";
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { resolveToolCall, toolDefinitions } from "../sandbox/tools.ts";
import { invoke } from "../triggers/triggers.ts";
import { createAgents } from "./agents.ts";
import { agentToolName } from "./agentTool.ts";
import { agentTools } from "./defs.ts";
import { memoryKvAdapter } from "./kv.ts";
import { agent } from "./loop.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client, { store: memoryKvAdapter() });

const researcher = agents.agent(
  { id: "researcher", description: "Looks facts up" },
  async () => {
    return { answer: "42" };
  },
);

const coder = agents.agent(
  {
    id: "coder",
    on: invoke(z.object({ task: z.string(), lang: z.string().optional() })),
  },
  async () => {
    return { summary: "done" };
  },
);

// Runs one tool call inside a function and returns the steps it created.
const callTool = async (
  tools: Parameters<typeof resolveToolCall>[0],
  name: string,
  input: Record<string, unknown>,
  eventData: Record<string, unknown> = {},
) => {
  const fn = client.createFunction(
    { id: "caller", triggers: [{ event: "foo" }] },
    async () => {
      const resolved = await resolveToolCall(
        tools,
        { op: "call", id: 1, tool: name, args: [], kwargs: input },
        JSON.stringify(input),
      );

      if (resolved.error !== undefined) {
        throw new Error(resolved.error);
      }

      await resolved.invoke({
        signal: new AbortController().signal,
        idempotencyKey: "k",
      });
    },
  );
  const result = await runFnWithStack(
    fn,
    {},
    { event: { name: "foo", data: eventData } as never },
  );

  if (result.type === "function-rejected") {
    throw new Error(JSON.stringify((result as { error?: unknown }).error));
  }

  if (result.type !== "steps-found") {
    throw new Error(`unexpected ${result.type}`);
  }

  return result.steps;
};

describe("an agent as a tool", () => {
  test("a plain agent takes a message, described by its description", () => {
    const [definition] = toolDefinitions({ researcher });

    expect(definition).toMatchObject({
      name: "researcher",
      description: "Looks facts up",
      input_schema: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
      },
    });
  });

  test("a typed agent takes its invoke schema and has a fallback description", () => {
    const [definition] = toolDefinitions({ coder });

    expect(definition?.description).toMatch(/coder/);
    expect(definition?.input_schema).toMatchObject({
      required: ["task"],
      properties: { task: { type: "string" }, lang: { type: "string" } },
    });
  });

  test("sanitises the ID into a tool name in a list", () => {
    expect(agentToolName("my-agent.v2")).toBe("my_agent_v2");
    expect(agentToolName("2fast")).toBe("agent_2fast");
    expect(Object.keys(agentTools([researcher, coder]))).toEqual([
      "researcher",
      "coder",
    ]);
  });

  test("a call to a plain agent invokes it with a message to its thread", async () => {
    const steps = await callTool({ researcher }, "researcher", {
      message: "why",
    });

    expect(steps[0]?.op).toBe("InvokeFunction");
    expect(steps[0]?.opts).toMatchObject({
      function_id: `${testClientId}-researcher`,
      payload: {
        data: {
          agent: `${testClientId}/researcher`,
          thread: "researcher:run.0",
          text: "why",
          _agent: { depth: 1, thread: "researcher:run.0" },
        },
      },
    });
  });

  test("a call to a typed agent passes the input as its data", async () => {
    const steps = await callTool({ coder }, "coder", { task: "fizzbuzz" });

    expect(steps[0]?.opts).toMatchObject({
      function_id: `${testClientId}-coder`,
      payload: { data: { task: "fizzbuzz", _agent: { depth: 1 } } },
    });
  });

  test("a bad input is refused before any agent starts", async () => {
    await expect(callTool({ coder }, "coder", {})).rejects.toThrow(
      /Invalid arguments for coder/,
    );
  });

  test("mayCall does not stop a tool but still stops agent.invoke", async () => {
    const limits = { depth: 2, mayCall: [["other/*"]] };
    const steps = await callTool(
      { researcher },
      "researcher",
      { message: "x" },
      {
        _agent: { depth: 1, limits },
      },
    );

    expect(steps[0]?.op).toBe("InvokeFunction");

    const fn = client.createFunction(
      { id: "caller2", triggers: [{ event: "foo" }] },
      async () => {
        await agent.invoke(researcher, {});
      },
    );

    await expect(
      runFnWithStack(
        fn,
        {},
        {
          event: {
            name: "foo",
            data: { _agent: { depth: 1, limits } },
          } as never,
        },
      ),
    ).resolves.toMatchObject({ type: "function-rejected" });
  });

  test("depth still applies to a tool", async () => {
    await expect(
      callTool(
        { researcher },
        "researcher",
        { message: "x" },
        {
          _agent: { depth: 1, limits: { depth: 0 } },
        },
      ),
    ).rejects.toThrow(/was not started/);
  });
});
