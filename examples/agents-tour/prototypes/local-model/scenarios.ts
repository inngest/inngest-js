/**
 * @module
 * The three tour-shaped scenarios. Each builds `AgentModelRequest`s the way
 * the SDK loop does: the whole conversation each call, tool results in one
 * `tool` message, an inbox event worded by `defaultFormat` (JSON of name and
 * data). Throwaway prototype.
 */
import type {
  AgentMessage,
  AgentModel,
  AgentModelResponse,
  AgentToolCall,
} from "inngest/experimental/agents";

type ToolJson = {
  name: string;
  description?: string;
  input_schema: { type: "object"; [key: string]: unknown };
};

/**
 * One model call, as the transcript records it.
 */
export interface Step {
  label: string;
  requestSummary: string;
  raw: string;
  text: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  ms: number;
  firstTokenMs: number;
  outputTokens: number;
  promptTokens: number;
  pass: boolean;
  note: string;
}

/**
 * One scenario run: its steps, and how far it got.
 */
export interface Run {
  scenario: string;
  steps: Step[];
  reached: number;
  of: number;
  pass: boolean;
  ms: number;
}

/**
 * What a scenario needs from the harness: call the model, read its stats.
 */
export interface Harness {
  model: AgentModel;
  stats: () => {
    raw: string;
    firstTokenMs: number;
    outputTokens: number;
    promptTokens: number;
  };
}

const summarize = (messages: AgentMessage[]): string => {
  const last = messages.at(-1);

  if (!last) {
    return "";
  }

  if (last.role === "tool") {
    return `tool results: ${last.results
      .map((result) => {
        return result.name;
      })
      .join(", ")}`;
  }

  const text =
    typeof last.content === "string"
      ? last.content
      : JSON.stringify(last.content);

  return `${last.role}: ${text.slice(0, 100)}`;
};

/**
 * A conversation that calls the model the way the loop does and records each
 * call.
 */
class Conversation {
  messages: AgentMessage[] = [];
  steps: Step[] = [];
  turn = 0;

  harness: Harness;
  system: string | undefined;
  tools: ToolJson[];

  constructor(harness: Harness, system: string | undefined, tools: ToolJson[]) {
    this.harness = harness;
    this.system = system;
    this.tools = tools;
  }

  user(content: string) {
    this.messages.push({ role: "user", content });
  }

  results(calls: AgentToolCall[], contents: string[]) {
    this.messages.push({
      role: "tool",
      results: calls.map((call, index) => {
        return {
          toolCallId: call.id,
          name: call.name,
          input: call.input,
          content: contents[index] ?? "{}",
        };
      }),
    });
  }

  async ask(
    label: string,
    check: (answer: AgentModelResponse) => { pass: boolean; note: string },
  ): Promise<{ answer: AgentModelResponse; pass: boolean }> {
    this.turn += 1;

    const requestSummary = summarize(this.messages);
    const started = performance.now();
    const answer = await this.harness.model({
      system: this.system,
      messages: this.messages,
      turn: this.turn,
      maxTurns: 20,
      tools: this.tools,
    });
    const ms = performance.now() - started;
    const stats = this.harness.stats();
    const checked = check(answer);

    this.messages.push(answer.message);
    this.steps.push({
      label,
      requestSummary,
      raw: stats.raw,
      text: answer.text ?? "",
      toolCalls: answer.toolCalls.map((call) => {
        return { name: call.name, input: call.input };
      }),
      ms,
      firstTokenMs: stats.firstTokenMs,
      outputTokens: stats.outputTokens,
      promptTokens: stats.promptTokens,
      pass: checked.pass,
      note: checked.note,
    });

    return { answer, pass: checked.pass };
  }
}

const finish = (
  scenario: string,
  conversation: Conversation,
  of: number,
): Run => {
  const reached = conversation.steps.filter((step) => {
    return step.pass && step.label !== "ack";
  }).length;

  return {
    scenario,
    steps: conversation.steps,
    reached,
    of,
    pass: reached === of,
    ms: conversation.steps.reduce((sum, step) => {
      return sum + step.ms;
    }, 0),
  };
};

const noTool = (answer: AgentModelResponse) => {
  return answer.toolCalls.length === 0;
};

// ---- Answer ---------------------------------------------------------------

/**
 * Answer: a short reply with no tool call, then a follow-up that refers back.
 */
export const answerScenario = async (harness: Harness): Promise<Run> => {
  const conversation = new Conversation(
    harness,
    "You help the team with engineering questions.",
    [],
  );

  conversation.user(
    "Name three HTTP status codes that mean the client made a mistake, as a numbered list with the code and its name.",
  );

  const first = await conversation.ask("answer", (answer) => {
    const codes = (answer.text ?? "").match(/\b4\d\d\b/g) ?? [];
    const distinct = new Set(codes).size;
    const short = (answer.text ?? "").length <= 500;
    const pass = noTool(answer) && distinct >= 2 && short;

    return {
      pass,
      note: `tools=${answer.toolCalls.length} codes=${distinct} len=${(answer.text ?? "").length}`,
    };
  });
  // The code on the second line of the model's own list.
  const lines = (first.answer.text ?? "").split("\n").filter((line) => {
    return /\b4\d\d\b/.test(line);
  });
  const second = lines[1]?.match(/\b4\d\d\b/)?.[0];

  conversation.user("and the second one?");

  await conversation.ask("follow-up", (answer) => {
    const text = answer.text ?? "";
    const asks = /which|clarify|could you|what do you mean|more context/i.test(
      text,
    );
    const pass =
      second !== undefined && text.includes(second) && !asks && noTool(answer);

    return { pass, note: `second=${second ?? "none"} asks=${asks}` };
  });

  return finish("answer", conversation, 2);
};

// ---- One tool -------------------------------------------------------------

const orderTools: ToolJson[] = [
  {
    name: "lookup_order",
    description: "Looks up an order by its id and returns its status.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string", description: "The order id." } },
      required: ["order_id"],
    },
  },
  {
    name: "get_weather",
    description: "Gets the current weather for a city.",
    input_schema: {
      type: "object",
      properties: { city: { type: "string", description: "City name." } },
      required: ["city"],
    },
  },
  {
    name: "create_ticket",
    description: "Creates a support ticket.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title." },
        priority: { enum: ["low", "medium", "high"] },
      },
      required: ["title", "priority"],
    },
  },
  {
    name: "search_docs",
    description: "Searches the product docs.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Words." } },
      required: ["query"],
    },
  },
];

const orderSystem =
  "You help customers. Use a tool only when it is needed to answer.";

/**
 * One tool: the right tool with the right arguments, a final answer that uses
 * the result, and a question that needs no tool.
 */
export const toolScenario = async (harness: Harness): Promise<Run> => {
  const conversation = new Conversation(harness, orderSystem, orderTools);

  conversation.user("Where is my order A-1043?");

  const call = await conversation.ask("call", (answer) => {
    const [only] = answer.toolCalls;
    const input = only?.input as { order_id?: unknown } | undefined;
    const pass =
      answer.toolCalls.length === 1 &&
      only?.name === "lookup_order" &&
      input?.order_id === "A-1043";

    return {
      pass,
      note: `calls=${answer.toolCalls.map((c) => c.name).join(",") || "none"} args=${JSON.stringify(input)}`,
    };
  });

  if (call.pass) {
    conversation.results(call.answer.toolCalls, [
      JSON.stringify({
        order_id: "A-1043",
        status: "shipped",
        carrier: "UPS",
        eta: "2026-11-04",
      }),
    ]);

    await conversation.ask("final", (answer) => {
      const text = answer.text ?? "";
      const pass =
        noTool(answer) && /shipped|ups|nov(ember)?\.? 4|2026-11-04/i.test(text);

      return { pass, note: `tools=${answer.toolCalls.length}` };
    });
  }

  const none = new Conversation(harness, orderSystem, orderTools);

  none.user("What does HTTP status 404 mean?");

  await none.ask("no-tool", (answer) => {
    const pass = noTool(answer) && /not found/i.test(answer.text ?? "");

    return {
      pass,
      note: `calls=${answer.toolCalls.map((c) => c.name).join(",") || "none"}`,
    };
  });

  conversation.steps.push(...none.steps);

  return finish("tool", conversation, 3);
};

// ---- Find and start an agent ----------------------------------------------

const agentTools: ToolJson[] = [
  {
    name: "list_agents",
    description:
      "Lists the agents you can start or message, with what each does. Pass a few words in `query` to narrow the list.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to look for." } },
    },
  },
  {
    name: "describe_agent",
    description:
      "The full card of one agent: what it does and the input starting it takes.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "The agent's id." } },
      required: ["id"],
    },
  },
  {
    name: "start_agent",
    description:
      "Starts an agent on a thread and returns the thread's id. Its result reaches you later as a message. `input` is what describe_agent says the agent accepts.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The agent's id." },
        input: { type: "object", description: "What to hand the agent." },
      },
      required: ["id", "input"],
    },
  },
  {
    name: "reply",
    description: "Sends a message to a started agent's thread.",
    input_schema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "The thread id." },
        text: { type: "string", description: "The message." },
      },
      required: ["thread", "text"],
    },
  },
];

const cards = [
  {
    id: "platform/reviewer",
    description: "Reviews a pull request and reports what it finds.",
  },
  {
    id: "platform/triager",
    description: "Reads new issues, labels them and assigns an owner.",
  },
  {
    id: "platform/release-notes",
    description: "Drafts release notes from merged pull requests.",
  },
];

const reviewerCard = {
  ...cards[0],
  input: {
    type: "object",
    properties: { pr: { type: "string", description: "The pull request number." } },
    required: ["pr"],
  },
};

const finished = {
  event: "agent/finished",
  data: {
    thread: "th_42",
    agent: "platform/reviewer",
    result: {
      approved: false,
      summary:
        "Two issues: a missing null check in parser.ts and no test for the retry path.",
    },
  },
};

const callIs = (answer: AgentModelResponse, name: string) => {
  return answer.toolCalls.length === 1 && answer.toolCalls[0]?.name === name;
};

/**
 * Find and start an agent: list_agents, describe_agent, start_agent with
 * `{ pr: "42" }`, then a final answer once `agent/finished` is folded in.
 */
export const chainScenario = async (harness: Harness): Promise<Run> => {
  const conversation = new Conversation(
    harness,
    "You are a coding assistant. Other agents can do work for you: find them with list_agents, read their input with describe_agent, start one with start_agent, and its result arrives later as a message.",
    agentTools,
  );

  conversation.user("Get PR 42 reviewed.");

  const list = await conversation.ask("list_agents", (answer) => {
    return {
      pass: callIs(answer, "list_agents"),
      note: `calls=${answer.toolCalls.map((c) => c.name).join(",") || "none"}`,
    };
  });

  if (!list.pass) {
    return finish("chain", conversation, 4);
  }

  conversation.results(list.answer.toolCalls, [JSON.stringify({ agents: cards })]);

  const describe = await conversation.ask("describe_agent", (answer) => {
    const input = answer.toolCalls[0]?.input as { id?: unknown } | undefined;

    return {
      pass: callIs(answer, "describe_agent") && input?.id === "platform/reviewer",
      note: `calls=${answer.toolCalls.map((c) => c.name).join(",") || "none"} args=${JSON.stringify(input)}`,
    };
  });

  if (!describe.pass) {
    return finish("chain", conversation, 4);
  }

  conversation.results(describe.answer.toolCalls, [JSON.stringify(reviewerCard)]);

  const start = await conversation.ask("start_agent", (answer) => {
    const input = answer.toolCalls[0]?.input as
      | { id?: unknown; input?: { pr?: unknown } }
      | undefined;
    const pr = input?.input?.pr;

    return {
      pass:
        callIs(answer, "start_agent") &&
        input?.id === "platform/reviewer" &&
        String(pr) === "42",
      note: `calls=${answer.toolCalls.map((c) => c.name).join(",") || "none"} args=${JSON.stringify(input)}`,
    };
  });

  if (!start.pass) {
    return finish("chain", conversation, 4);
  }

  conversation.results(start.answer.toolCalls, [
    JSON.stringify({ started: true, thread: "th_42" }),
  ]);

  // The model says what it did; the loop then ends and the inbox wakes it.
  await conversation.ask("ack", (answer) => {
    return { pass: true, note: `tools=${answer.toolCalls.length}` };
  });

  conversation.user(JSON.stringify({ event: finished.event, data: finished.data }));

  await conversation.ask("final", (answer) => {
    const text = answer.text ?? "";
    const pass =
      noTool(answer) &&
      /null check|retry|two issues|2 issues|not approved|changes/i.test(text);

    return { pass, note: `tools=${answer.toolCalls.length}` };
  });

  return finish("chain", conversation, 4);
};

export const scenarios = {
  answer: answerScenario,
  tool: toolScenario,
  chain: chainScenario,
} as const;
