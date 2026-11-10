/**
 * @module
 * Tests for the briefing: the text in the four example situations, the
 * agent's `briefing` option, the `context` of tools lifted into it, the
 * tool sets the defaults give, and that the runtime section is the same for
 * every run of an agent with the same tools (so it caches).
 */
import { z } from "zod/v4";
import { Inngest } from "../../../components/Inngest.ts";
import { tool, toolDefinitions } from "../../../components/sandbox/tools.ts";
import { eventType } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createListenTools } from "../inbox/inboxTools.ts";
import { reportTool } from "../inbox/reports.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import type { AgentModelRequest, AgentModelResponse } from "../loop/loop.ts";
import { model } from "../loop/loopKit.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import {
  agentToolsFor,
  handlerWaitTool,
  replyTool,
  waitTool,
} from "./agentTools.ts";
import {
  type BriefingFacts,
  briefingFacts,
  briefingParts,
  renderBriefing,
  toolFacts,
} from "./briefing.ts";
import { relatedKey } from "./relations.ts";
import { freshKv, run } from "./test-helpers.ts";

beforeEach(() => {
  freshKv();
});

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
  };
};

const chat = tool({
  description: {
    does: "Sends a message to the person you are talking with.",
    use: "for anything the person should read",
    context:
      "Only messages sent with `chat` reach the person; anything else you write is private",
  },
  input: z.object({ text: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  run: async () => {
    return { ok: true as const };
  },
});

const progress = {
  type: "object",
  properties: { ms: { type: "number" }, note: { type: "string" } },
  required: ["ms", "note"],
};

/**
 * The four situations of the proposal, as facts.
 */
const examples: Record<string, BriefingFacts> = {
  "a person-started bare agent": {
    agent: "acme/helper",
    thread: "8d1e2f",
    loop: "default",
    reports: [],
    group: false,
    tools: toolFacts({ wait: waitTool }),
  },
  "the lead, with discovery and a chat tool": {
    agent: "agent-playground/lead",
    thread: "s-7f2c",
    loop: "default",
    reports: [],
    group: false,
    depth: 2,
    tools: toolFacts({ ...agentToolsFor(true), wait: waitTool, chat }),
  },
  "a child optimizer owing a required report": {
    agent: "agent-playground/optimizer",
    thread:
      "agent-playground/optimizer:01M6.0.0123456789abcdef.agent-playground%2Flead",
    loop: "default",
    starter: {
      kind: "agent",
      address: "agent-playground/lead",
      thread: "s-7f2c",
    },
    opener: {
      kind: "agent",
      address: "agent-playground/lead",
      thread: "s-7f2c",
      start: true,
    },
    reports: [
      {
        type: "demo/progress",
        required: true,
        schema: progress,
        to: ["agent-playground/lead"],
      },
    ],
    group: false,
    tools: toolFacts({
      ...agentToolsFor(undefined, true),
      report: reportTool({
        spec: {
          "demo/progress": {
            schema: progress,
            required: true,
            to: [{ agent: "agent-playground/lead", thread: "s-7f2c" }],
          },
        },
        sent: new Set(),
      }),
      wait: waitTool,
    }),
  },
  "a custom handler's loop": {
    agent: "agent-playground/security",
    thread: "agent-playground/security:01M7.0.0123456789abcdef.",
    loop: "handler",
    opener: { kind: "function", run: "01M7", start: true },
    reports: [],
    group: false,
    tools: toolFacts({ wait: handlerWaitTool }),
  },
};

describe("the briefing text", () => {
  test.each(Object.entries(examples))("%s", (_name, facts) => {
    expect(renderBriefing(facts).text).toMatchSnapshot();
  });

  test("has a versioned runtime section and a situation section", () => {
    const { text, sections } = renderBriefing(
      examples["a person-started bare agent"] as BriefingFacts,
    );

    expect(Object.keys(sections)).toEqual(["runtime", "situation"]);
    expect(sections.runtime).toMatch(
      /^<inngest-runtime v="1">\n[\s\S]*\n<\/inngest-runtime>$/,
    );
    expect(sections.situation).toMatch(
      /^<inngest-situation>\n[\s\S]*\n<\/inngest-situation>$/,
    );
    expect(text).toBe(`${sections.runtime}\n${sections.situation}`);
  });

  test("a child that can't start agents is told so, only when it has start_agent", () => {
    const facts = examples[
      "a child optimizer owing a required report"
    ] as BriefingFacts;

    expect(renderBriefing({ ...facts, depth: 0 }).text).not.toContain(
      "depth limit",
    );
    expect(
      renderBriefing({
        ...facts,
        depth: 0,
        tools: toolFacts({ ...agentToolsFor(true), wait: waitTool }),
      }).text,
    ).toContain("You can't start agents (depth limit).");
  });
});

describe("the briefing option", () => {
  const facts = examples["a person-started bare agent"] as BriefingFacts;

  test("left out, the default sections are sent", () => {
    expect(briefingParts(facts, undefined)).toEqual(
      renderBriefing(facts).sections,
    );
  });

  test("a string replaces the whole briefing", () => {
    expect(briefingParts(facts, () => "mine")).toEqual({
      runtime: "",
      situation: "mine",
    });
  });

  test.each([null, undefined, false, ""] as const)("%s drops it", (value) => {
    expect(briefingParts(facts, () => value)).toBeUndefined();
  });

  test("gets the text, every section by name and the facts", () => {
    const seen = vi.fn(() => undefined);

    briefingParts(facts, seen);

    expect(seen).toHaveBeenCalledWith({
      ...renderBriefing(facts),
      facts,
    });
  });
});

describe("tool context", () => {
  test("is lifted into the situation and left out of the description", () => {
    const facts = toolFacts({ chat, wait: waitTool });

    expect(facts.contexts).toEqual([
      {
        tool: "chat",
        context:
          "Only messages sent with `chat` reach the person; anything else you write is private.",
      },
    ]);

    const { sections } = renderBriefing({
      ...(examples["a person-started bare agent"] as BriefingFacts),
      tools: facts,
    });

    expect(sections.runtime).not.toContain("chat");
    expect(sections.situation).toContain(
      "From your tools:\n- chat: Only messages sent with `chat` reach the person; anything else you write is private.",
    );
  });

  test("a tool with a string description has none", () => {
    expect(
      toolFacts({
        plain: tool({
          description: "Does a thing.",
          run: async () => {
            return 1;
          },
        }),
      }).contexts,
    ).toEqual([]);
  });

  test("the built-ins that carry one: start_agent, message_agent, list_agents, report", () => {
    const facts = examples[
      "the lead, with discovery and a chat tool"
    ] as BriefingFacts;

    expect(
      facts.tools.contexts.map((entry) => {
        return entry.tool;
      }),
    ).toEqual(["list_agents", "start_agent", "message_agent", "chat"]);
  });

  test("inbox_listen carries one, and inbox tools show their result shape", () => {
    const listen = createListenTools(
      {
        open: async () => {
          return { close: async () => [] };
        },
      },
      [eventType("ci/status", { schema: z.object({ n: z.number() }) })],
    );

    expect(toolFacts(listen).contexts).toEqual([
      {
        tool: "inbox_listen",
        context:
          "Events that reach an inbox you opened with `inbox_listen` are handed to you as messages at your next turn, until you close it or the run ends.",
      },
    ]);

    const shown = toolDefinitions(listen);

    expect(shown[0]?.description).toMatch(
      /Returns: \{ listening: string, source: string \}$/,
    );
    expect(shown[1]?.description).toMatch(
      /Returns: \{ closed: string, unread\?: \{ source: string, content: string \}\[\] \}$/,
    );
  });
});

/**
 * A model that keeps every request and answers from `replies`, marked as one
 * that places the briefing itself when `places` is set.
 */
const recording = (
  replies: AgentModelResponse[] = [say("done")],
  places = false,
) => {
  const requests: AgentModelRequest[] = [];
  const scripted = model(async (request) => {
    requests.push(structuredClone(request));

    return replies[requests.length - 1] ?? say("done");
  });

  return {
    requests,
    scripted: places
      ? Object.assign(scripted, { placesBriefing: true })
      : scripted,
  };
};

const toolNames = (request: AgentModelRequest | undefined) => {
  return (request?.tools ?? []).map((entry) => {
    return entry.name;
  });
};

const outside = (content: string, thread = "t1", agent = "bot") => {
  return {
    name: "agent/message",
    data: { agent: `${testClientId}/${agent}`, thread, content },
  };
};

describe("an agent run's briefing", () => {
  test("a model that doesn't place it gets it at the end of system", async () => {
    const { requests, scripted } = recording();
    const { fn } = createAgentFunction(new Inngest({ id: testClientId }), {
      id: "bot",
      model: scripted,
      system: "Be brief.",
    });

    await run(fn, { event: outside("hi"), timeouts: 1 });

    expect(requests[0]?.briefing).toBeUndefined();
    expect(requests[0]?.system).toMatch(
      /^Be brief\.\n\n<inngest-runtime v="1">\n[\s\S]*<\/inngest-runtime>\n<inngest-situation>\n[\s\S]*<\/inngest-situation>$/,
    );
    expect(requests[0]?.system).toContain(
      "This run ends after 2 minutes with no new message. A message after that starts a new run of this thread, with your history.",
    );
  });

  test("a model that places it gets the parts and the app's system alone", async () => {
    const { requests, scripted } = recording([say("done")], true);
    const { fn } = createAgentFunction(new Inngest({ id: testClientId }), {
      id: "bot",
      model: scripted,
      system: "Be brief.",
    });

    await run(fn, { event: outside("hi") });

    expect(requests[0]?.system).toBe("Be brief.");
    expect(requests[0]?.briefing?.runtime).toMatch(/^<inngest-runtime v="1">/);
    expect(requests[0]?.briefing?.situation).toContain(
      `You are ${testClientId}/bot, on thread \`t1\`.`,
    );
  });

  test("the option replaces or drops it", async () => {
    const replaced = recording();
    const dropped = recording();
    const client = new Inngest({ id: testClientId });
    const seen: string[] = [];

    await run(
      createAgentFunction(client, {
        id: "bot",
        model: replaced.scripted,
        system: "S",
        briefing: ({ sections }) => {
          seen.splice(0, seen.length, ...Object.keys(sections));

          return `mine\n${sections.situation}`;
        },
      }).fn,
      { event: outside("hi") },
    );
    await run(
      createAgentFunction(client, {
        id: "bot",
        model: dropped.scripted,
        system: "S",
        briefing: () => null,
      }).fn,
      { event: outside("hi") },
    );

    expect(seen).toEqual(["runtime", "situation"]);
    expect(replaced.requests[0]?.system).toMatch(
      /^S\n\nmine\n<inngest-situation>/,
    );
    expect(replaced.requests[0]?.system).not.toContain("<inngest-runtime");
    expect(dropped.requests[0]?.system).toBe("S");
  });

  test("a whole loop of the agent's own gets none, and can make it with briefingFacts()", async () => {
    let made: string | undefined;
    const client = new Inngest({ id: testClientId });
    const { fn } = createAgentFunction(
      client,
      {
        id: "bot",
        model: recording().scripted,
      },
      async ({ inbox }) => {
        await inbox.next();

        const facts = briefingFacts({ chat });

        made = facts && renderBriefing(facts).sections.situation;

        return null;
      },
    );

    await run(fn, { event: outside("hi") });

    expect(made).toContain(`You are ${testClientId}/bot, on thread \`t1\`.`);
    expect(made).toContain("- chat: Only messages sent with `chat`");
  });

  test("a tool's context is in the briefing only for an agent that has the tool", async () => {
    const withChat = recording();
    const without = recording();
    const client = new Inngest({ id: testClientId });

    await run(
      createAgentFunction(client, {
        id: "bot",
        model: withChat.scripted,
        tools: { chat },
      }).fn,
      { event: outside("hi") },
    );
    await run(
      createAgentFunction(client, {
        id: "bot",
        model: without.scripted,
      }).fn,
      { event: outside("hi") },
    );

    expect(withChat.requests[0]?.system).toContain("From your tools:\n- chat:");
    expect(
      withChat.requests[0]?.tools.find((entry) => {
        return entry.name === "chat";
      })?.description,
    ).toBe(
      "Sends a message to the person you are talking with. Use it for anything the person should read. Returns: { ok: true }",
    );
    expect(without.requests[0]?.system).not.toContain("From your tools");
  });
});

describe("the defaults", () => {
  test("a bare agent a trigger started has only wait, and ends when nothing is unread", async () => {
    const { requests, scripted } = recording();
    const { fn } = createAgentFunction(new Inngest({ id: testClientId }), {
      id: "bot",
      model: scripted,
    });

    await run(fn, { event: outside("hi") });

    expect(toolNames(requests[0])).toEqual(["wait"]);
    expect(requests[0]?.system).toContain(
      "This run ends when you finish a turn with nothing unread.",
    );
  });

  test("discovery: true gives today's agent tools, without reply", async () => {
    const { requests, scripted } = recording();
    const { fn } = createAgentFunction(new Inngest({ id: testClientId }), {
      id: "bot",
      model: scripted,
      discovery: true,
    });

    await run(fn, { event: outside("hi") });

    expect(toolNames(requests[0])).toEqual([
      "list_agents",
      "describe_agent",
      "start_agent",
      "message_agent",
      "ask_agent",
      "stop_agent",
      "wait",
    ]);
  });

  test("a thread another agent started gets the tools that reach its relatives, without discovery", async () => {
    const client = new Inngest({ id: testClientId });
    const { requests, scripted } = recording();
    const key = relatedKey(client, `${testClientId}/bot:run-1.0`, {
      key: "lead-thread",
      address: "app/lead",
    });
    const { fn } = createAgentFunction(client, {
      id: "bot",
      model: scripted,
    });

    await run(fn, { event: outside("steer", key) });

    expect(toolNames(requests[0])).toEqual([
      "message_agent",
      "ask_agent",
      "stop_agent",
      "wait",
    ]);
    expect(requests[0]?.system).toContain("app/lead started this thread.");
    expect(requests[0]?.system).toContain(
      "This run was opened by a message from outside the agent team.",
    );
  });

  test("reply comes with the first question and stays", async () => {
    const asked = recording([say("one"), say("two")]);
    const plain = recording();
    const client = new Inngest({ id: testClientId });
    const question = {
      name: "agent/question",
      data: {
        agent: `${testClientId}/bot`,
        thread: "t1",
        id: "q1",
        text: "Which file?",
        from: { kind: "agent", address: "app/other", key: "k2" },
      },
    };

    await run(
      createAgentFunction(client, {
        id: "bot",
        model: asked.scripted,
      }).fn,
      { event: question },
    );
    await run(
      createAgentFunction(client, {
        id: "bot",
        model: plain.scripted,
      }).fn,
      { event: outside("hi") },
    );

    expect(toolNames(asked.requests[0])).toEqual(["wait", "reply"]);
    expect(toolNames(plain.requests[0])).toEqual(["wait"]);
    expect(replyTool).toBeDefined();
  });

  test("the handler's own loop gets a wait that promises no wake-up", async () => {
    const { requests, scripted } = recording();
    const { fn } = createAgentFunction(
      new Inngest({ id: testClientId }),
      { id: "bot", model: scripted },
      async ({ inbox, loop }) => {
        await inbox.next();
        await loop("go");

        return null;
      },
    );

    await run(fn, { event: outside("hi") });

    const wait = requests[0]?.tools.find((entry) => {
      return entry.name === "wait";
    });

    expect(wait?.description).toContain("goes back to your agent's code");
    expect(wait?.description).not.toContain("woken");
  });
});

/**
 * A client whose platform lists `child` as live, so `start_agent` can start it.
 */
const liveClient = () => {
  return new Inngest({
    id: testClientId,
    fetch: (async () => {
      return new Response(
        JSON.stringify([
          {
            slug: `${testClientId}-child`,
            is_paused: false,
            is_archived: false,
          },
        ]),
        { status: 200 },
      );
    }) as never,
  });
};

describe("a started child", () => {
  /**
   * Runs a lead whose model starts `child` with `reports`, and gives back the
   * start message it sent.
   */
  const startFromLead = async (
    client: Inngest,
    leadId: string,
    reports: unknown[],
  ) => {
    const sent: { id?: string; name: string; data: Record<string, unknown> }[] =
      [];

    Object.defineProperty(client, "_send", {
      configurable: true,
      value: async (input: { payload: unknown }) => {
        for (const event of [input.payload].flat()) {
          if (!JSON.stringify(sent).includes(JSON.stringify(event))) {
            sent.push(event as (typeof sent)[number]);
          }
        }

        return { ids: [], status: 200 };
      },
    });
    vi.spyOn(client, "queryInsights").mockRejectedValue(
      new Error("Insights query failed: 501 Not Implemented - no"),
    );
    vi.spyOn(client, "listEvents").mockResolvedValue([]);

    const lead = recording([
      {
        message: { role: "assistant", content: [] },
        toolCalls: [
          {
            id: "c1",
            name: "start_agent",
            input: { address: `${testClientId}/child`, input: "go", reports },
          },
        ],
      },
      say("started"),
    ]);
    const agents = createAgents(client, { store: memoryKvAdapter() });

    agents.agent({ id: "child" });

    // A handler of its own, so the run ends without waiting for the child.
    const leadAgent = agents.agent(
      { id: leadId, model: lead.scripted, discovery: true },
      async ({ inbox, loop }) => {
        await inbox.next();
        await loop("start it");

        return null;
      },
    );

    await run(leadAgent.fn, {
      event: outside("start it", `${leadId}-thread`, leadId),
    });

    const start = sent.find((event) => {
      return (
        event.name === "agent/message" &&
        (event.data.from as { thread?: string } | undefined)?.thread !==
          undefined
      );
    });

    if (!start) {
      throw new Error("the lead started nothing");
    }

    return start;
  };

  /**
   * Runs `child`'s model on `start` and gives back its first request.
   */
  const runChild = async (client: Inngest, start: unknown) => {
    const child = recording([], true);
    const { fn } = createAgentFunction(client, {
      id: "child",
      model: child.scripted,
    });

    // As the executor delivers it: plain JSON.
    await run(fn, { event: JSON.parse(JSON.stringify(start)) });

    return child.requests[0] as AgentModelRequest;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a report the model asks for is required unless it says required: false", async () => {
    const client = liveClient();
    const start = await startFromLead(client, "lead", [
      { type: "demo/progress", schema: progress },
      { type: "demo/note", required: false },
    ]);
    const reports = (
      start.data.from as {
        reports: Record<string, { required?: boolean }>;
      }
    ).reports;

    expect(reports["demo/progress"]?.required).toBe(true);
    expect(reports["demo/note"]?.required).toBeUndefined();
  });

  test("sees who started it, where its result goes and the report it owes", async () => {
    const client = liveClient();
    const start = await startFromLead(client, "lead", [
      { type: "demo/progress", schema: progress },
    ]);
    const request = await runChild(client, start);

    expect(toolNames(request)).toEqual([
      "message_agent",
      "ask_agent",
      "stop_agent",
      "report",
      "wait",
    ]);
    expect(request.briefing?.situation).toContain(
      `${testClientId}/lead (thread lead-thread) started you. When you finish, your last text goes to it as your result`,
    );
    expect(request.briefing?.situation).toContain(
      `You owe ${testClientId}/lead reports of type "demo/progress" (required), with data { ms: number, note: string }.`,
    );
    expect(request.briefing?.situation).toContain(
      "This run ends when you finish a turn with nothing unread.",
    );
  });

  test("the runtime section and the tools are byte-identical across runs; only the situation differs", async () => {
    const client = liveClient();
    const first = await runChild(
      client,
      await startFromLead(client, "lead-a", [{ type: "demo/progress" }]),
    );
    const second = await runChild(
      client,
      await startFromLead(client, "lead-b", [{ type: "demo/progress" }]),
    );

    expect(second.briefing?.runtime).toBe(first.briefing?.runtime);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(second.system).toBe(first.system);
    expect(second.briefing?.situation).not.toBe(first.briefing?.situation);
  });
});
