/**
 * @module
 * Tests for an agent's `skills`: what the model is shown, `open_skill`, that
 * skills add no tools, and the card.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgentFunction } from "../agent/agentFunction.ts";
import { freshKv, run } from "../agent/test-helpers.ts";
import type {
  AgentModelRequest,
  AgentModelResponse,
  ModelMessage,
} from "../loop/loop.ts";
import { model } from "../loop/loopKit.ts";
import { type Skill, type SkillSource, skills } from "./skills.ts";

beforeEach(() => {
  freshKv();
});

const skill = (name: string, description: string, body: string): Skill => {
  return { name, description, body, files: [] };
};

const source = (...list: Skill[]): SkillSource => {
  return { kind: "inngest/skills.source", skills: list };
};

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
  };
};

const call = (name: string, input: unknown): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [] },
    toolCalls: [{ id: "c1", name, input }],
  };
};

const start = {
  name: "agent/message",
  data: { agent: `${testClientId}/bot`, thread: "t1", text: "go" },
};

const recording = (answers: AgentModelResponse[]) => {
  const requests: AgentModelRequest[] = [];
  const scripted = model(async (request) => {
    requests.push(structuredClone(request));

    return answers[requests.length - 1] ?? say("more");
  });

  return { requests, scripted };
};

const refund = skill("refund-policy", "How to decide a refund", "30 days.");
const style = skill("house-style", "How we write", "Be plain.");

const bot = (
  options: Record<string, unknown>,
  answers: AgentModelResponse[],
) => {
  const { requests, scripted } = recording(answers);
  const defined = createAgentFunction(new Inngest({ id: testClientId }), {
    id: "bot",
    model: scripted,
    idle: 0,
    ...options,
  });

  return { requests, ...defined };
};

const toolNames = (request?: AgentModelRequest) => {
  return (request?.tools ?? []).map((tool) => {
    return (tool as { name: string }).name;
  });
};

const asText = (messages: ModelMessage[]) => {
  return JSON.stringify(messages);
};

describe("what the model sees", () => {
  test("the first request lists each skill's name and description and no body; open_skill brings the body, with no sandbox", async () => {
    const { requests, fn } = bot({ skills: [source(refund, style)] }, [
      call("open_skill", { name: "refund-policy" }),
      say("done"),
    ]);

    await run(fn, { event: start });

    const first = JSON.stringify([requests[0]?.system, requests[0]?.messages]);

    expect(first).toContain("refund-policy");
    expect(first).toContain("How to decide a refund");
    expect(first).toContain("house-style");
    expect(first).not.toContain("30 days.");
    expect(asText(requests[1]?.messages ?? [])).toContain("30 days.");
  });

  test("an unknown skill name gives the model a readable answer", async () => {
    const { requests, fn } = bot({ skills: [source(refund)] }, [
      call("open_skill", { name: "nope" }),
      say("done"),
    ]);

    await run(fn, { event: start });

    expect(asText(requests[1]?.messages ?? [])).toContain("refund-policy");
  });

  test("skills add no tools: only open_skill is added, whichever skills are listed", async () => {
    const one = bot({ skills: [source(refund)] }, [say("a")]);
    const two = bot({ skills: [source(style, refund)] }, [say("b")]);
    const none = bot({}, [say("c")]);

    await run(one.fn, { event: start });
    await run(two.fn, { event: start });
    await run(none.fn, { event: start });

    expect(toolNames(one.requests[0])).toEqual(toolNames(two.requests[0]));
    expect(toolNames(one.requests[0])).toContain("open_skill");
    expect(toolNames(none.requests[0])).not.toContain("open_skill");
  });

  test("skills may be a function of the run", async () => {
    const { requests, fn } = bot(
      {
        skills: ({ event }: { event: { name: string } }) => {
          return [source(skill("by-event", `for ${event.name}`, "x"))];
        },
      },
      [say("done")],
    );

    await run(fn, { event: start });

    expect(requests[0]?.system).toContain("for agent/message");
  });
});

describe("at definition time", () => {
  test("two skills with one name across sources are an error", () => {
    expect(() => {
      bot({ skills: [source(refund), source(refund)] }, []);
    }).toThrow(/refund-policy/);
  });
});

describe("the card", () => {
  test("lists each skill's name and description, with nothing else", () => {
    const { card } = bot({ skills: [source(refund, style)] }, []);

    expect(card.skills).toEqual([
      { name: "refund-policy", description: "How to decide a refund" },
      { name: "house-style", description: "How we write" },
    ]);
  });
});

test("skills.folder is exported for an agent's skills field", () => {
  expect(typeof skills.folder).toBe("function");
});
