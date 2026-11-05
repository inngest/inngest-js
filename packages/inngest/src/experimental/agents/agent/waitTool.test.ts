/**
 * @module
 * The built-in `wait` tool ends the model's turn on purpose: the loop ends as
 * on a reply with no tool call, and the run waits for its next message. These
 * tests run the default handler request by request against the fake
 * executor, which replays the whole run each time.
 */
import { z } from "zod/v4";
import { Inngest } from "../../../components/Inngest.ts";
import { tool } from "../../../components/sandbox/tools.ts";
import { testClientId } from "../../../test/helpers.ts";
import type {
  AgentModelResponse,
  AgentToolCall,
  ModelMessage,
} from "../loop/loop.ts";
import { model } from "../loop/loopKit.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { waitResult } from "./agentTools.ts";
import { freshKv, run } from "./test-helpers.ts";

const message = (content: string) => {
  return {
    name: "agent/message",
    data: { agent: `${testClientId}/bot`, thread: "t1", content },
  };
};

const calling = (...calls: AgentToolCall[]): AgentModelResponse => {
  return {
    message: {
      role: "assistant",
      content: calls.map((call) => {
        return {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        };
      }),
    } as never,
    toolCalls: calls,
  };
};

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
  };
};

const wait: AgentToolCall = {
  id: "w1",
  name: "wait",
  input: { reason: "the optimizer reports when it is done" },
};

/**
 * An agent on the default handler whose model plays `script`, with a `note`
 * tool that counts its runs. `requests` has the messages of each model call
 * that really ran.
 */
const make = (
  script: AgentModelResponse[],
  tools: Record<string, unknown> = {},
) => {
  freshKv();

  const requests: ModelMessage[][] = [];
  const notes = { runs: 0 };
  const { fn } = createAgentFunction(new Inngest({ id: testClientId }), {
    id: "bot",
    model: model(async (request) => {
      requests.push(structuredClone(request.messages));

      return script[requests.length - 1] ?? say("more");
    }),
    tools: {
      note: tool({
        description: "Notes something.",
        input: z.object({}),
        run: async () => {
          notes.runs += 1;

          return "noted";
        },
      }),
      ...tools,
    },
  } as never);

  return { fn, requests, notes };
};

const userTexts = (messages: ModelMessage[]) => {
  return messages.flatMap((m) => {
    return m.role === "user" && typeof m.content === "string"
      ? [m.content]
      : [];
  });
};

describe("the wait tool", () => {
  test("ends the turn, and the next message wakes the run with a valid history", async () => {
    const { fn, requests } = make([calling(wait), say("got it")]);
    const { waiting } = await run(fn, {
      event: message("go"),
      incoming: [message("the report")],
    });

    // One call for the first batch: wait ended the turn. The next message
    // started the next batch.
    expect(requests).toHaveLength(2);
    expect(userTexts(requests[1] ?? [])).toEqual(["go", "the report"]);

    // The wait call has its result in the history, with its reason.
    const results = (requests[1] ?? []).flatMap((m) => {
      return m.role === "tool" ? m.results : [];
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      toolCallId: "w1",
      name: "wait",
      input: { reason: "the optimizer reports when it is done" },
    });
    expect((results[0] as { isError?: boolean }).isError).not.toBe(true);
    expect(JSON.stringify(results[0])).toContain(waitResult);
    expect(waiting).toBe(true);
  });

  test("with no message to come, the run waits as on a reply with no tool call", async () => {
    const { fn, requests } = make([calling(wait)]);
    const { waiting } = await run(fn, { event: message("go") });

    expect(requests).toHaveLength(1);
    expect(waiting).toBe(true);
  });

  test("other calls of the same reply run, once, and then the turn ends", async () => {
    const { fn, requests, notes } = make([
      calling({ id: "n1", name: "note", input: {} }, wait),
      say("got it"),
    ]);

    await run(fn, {
      event: message("go"),
      incoming: [message("the report")],
    });

    // The note ran once over every replay, and no model call came between it
    // and the next message.
    expect(notes.runs).toBe(1);
    expect(requests).toHaveLength(2);
    expect(userTexts(requests[1] ?? [])).toEqual(["go", "the report"]);
  });

  test("costs no step of its own, so a replay gives the same", async () => {
    const steps: string[] = [];
    const { fn } = make([calling(wait)]);

    await run(fn, {
      event: message("go"),
      onStep: (op) => {
        steps.push(op.userland?.id ?? op.id);
      },
    });

    expect(
      steps.filter((id) => {
        return id.includes("wait");
      }),
    ).toEqual([]);
  });

  test("a tool of the agent's own named wait replaces it and does not end the turn", async () => {
    const own = { runs: 0 };
    const { fn, requests } = make([calling(wait), say("done")], {
      wait: tool({
        description: "Waits my way.",
        input: z.object({}).passthrough(),
        run: async () => {
          own.runs += 1;

          return "mine";
        },
      }),
    });

    await run(fn, { event: message("go") });

    // Its result went back to the model, which was called again.
    expect(own.runs).toBe(1);
    expect(requests).toHaveLength(2);
  });
});
