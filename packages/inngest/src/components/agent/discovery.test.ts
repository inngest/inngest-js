/**
 * @module
 * Tests for agent discovery: the card an agent makes, how the registry is read
 * back from the events API, and the four tools.
 */
import { z } from "zod/v4";
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { resolveToolCall } from "../sandbox/tools.ts";
import { invoke } from "../triggers/triggers.ts";
import { createAgents } from "./agents.ts";
import {
  type AgentCard,
  addressOf,
  agentsRegisteredEvent,
  discoveryTools,
  matchCards,
  mayUse,
  readCards,
} from "./discovery.ts";
import { memoryKvAdapter } from "./kv.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client, { store: memoryKvAdapter() });

const docs = agents.agent(
  {
    id: "docs",
    description: "Answers questions about the docs",
    share: "team",
    owner: "docs-team",
    effects: "read",
    speed: "seconds",
    skills: [
      {
        id: "docs-qa",
        description: "Finds the page that answers a question",
        examples: ["How do I set up a cron?"],
      },
    ],
    on: invoke(z.object({ question: z.string() })),
  },
  async () => {
    return { answer: "read the docs" };
  },
);

const secret = agents.agent({ id: "secret" }, async () => {
  return null;
});

const card = (over: Partial<AgentCard> & { app: string; agentId: string }) => {
  return {
    ...docs.card,
    ...over,
    functionId: `${over.app}-${over.agentId}`,
  } as AgentCard;
};

describe("an agent's card", () => {
  test("is made from the definition", () => {
    expect(docs.card).toMatchObject({
      agentId: "docs",
      app: testClientId,
      functionId: `${testClientId}-docs`,
      does: "Answers questions about the docs",
      call: {
        input: { required: ["question"] },
      },
      message: { event: "agent/message" },
      triggers: [{ event: "inngest/function.invoked" }],
      share: "team",
      mode: "both",
      owner: "docs-team",
      effects: "read",
      speed: "seconds",
    });
    expect(docs.card.skills?.[0]?.id).toBe("docs-qa");
    expect(docs.card.version).toMatch(/^[0-9a-f]{8}$/);
  });

  test("defaults to private, write, and conversation without a typed input", () => {
    expect(secret.card).toMatchObject({
      share: "private",
      effects: "write",
      mode: "conversation",
      call: {},
    });
  });

  test("changes its version when it changes", () => {
    expect(docs.card.version).not.toBe(secret.card.version);
  });
});

describe("a schema that is not JSON Schema capable", () => {
  test("still marks the card as taking typed input", () => {
    const typed = agents.agent(
      {
        id: "legacy",
        on: invoke({
          "~standard": {
            version: 1,
            vendor: "legacy",
            validate: (value: unknown) => {
              return { value };
            },
          },
        } as never),
      },
      async () => {
        return null;
      },
    );

    expect(typed.card.call.input).toEqual({ type: "object" });
  });
});

describe("sharing and matching", () => {
  const a = card({ app: "a", agentId: "x", share: "private" });
  const b = card({ app: "b", agentId: "y", share: "team" });

  test("a private agent is for its own app, a team agent for all", () => {
    expect(mayUse(a, "a")).toBe(true);
    expect(mayUse(a, "b")).toBe(false);
    expect(mayUse(b, "a")).toBe(true);
  });

  test("a query matches the description and skills, best first", () => {
    const cards = [
      card({
        app: "a",
        agentId: "one",
        does: "Writes code",
        skills: undefined,
      }),
      card({
        app: "a",
        agentId: "two",
        does: "Answers questions",
        skills: undefined,
      }),
    ];

    expect(
      matchCards(cards, "questions").map((c) => {
        return c.agentId;
      }),
    ).toEqual(["two"]);
    expect(matchCards(cards)).toHaveLength(2);
    expect(matchCards(cards, "zebra")).toEqual([]);
  });
});

describe("reading the registry", () => {
  const event = (id: string, app: string, cards: AgentCard[]) => {
    return {
      id,
      internalId: id,
      name: agentsRegisteredEvent,
      data: { app, cards },
    };
  };
  const reading = (pages: ReturnType<typeof event>[][]) => {
    const listEvents = vi.fn(async ({ cursor }: { cursor?: string }) => {
      return cursor ? (pages[1] ?? []) : (pages[0] ?? []);
    });

    return { listEvents, fake: { listEvents } as unknown as Inngest.Any };
  };

  test("keeps the newest announcement of each app and pages through events", async () => {
    const old = card({ app: "a", agentId: "x", does: "old" });
    const fresh = card({ app: "a", agentId: "x", does: "fresh" });
    const other = card({ app: "b", agentId: "y", does: "other" });
    const { listEvents, fake } = reading([
      Array.from({ length: 50 }, (_, index) => {
        return index === 0
          ? event("e0", "a", [fresh])
          : event(`e${index}`, `filler${index}`, []);
      }),
      [event("last", "a", [old]), event("last2", "b", [other])],
    ]);
    const cards = await readCards(fake);

    expect(listEvents).toHaveBeenCalledTimes(2);
    expect(listEvents.mock.calls[1]?.[0]).toMatchObject({ cursor: "e49" });
    expect(
      cards.map((c) => {
        return `${addressOf(c)}:${c.does}`;
      }),
    ).toEqual(["a/x:fresh", "b/y:other"]);
  });

  test("an agent a newer announcement no longer lists is gone", async () => {
    const x = card({ app: "a", agentId: "x" });
    const y = card({ app: "a", agentId: "y" });
    const { fake } = reading([
      [event("new", "a", [x]), event("old", "a", [x, y])],
    ]);

    expect(
      (await readCards(fake)).map((c) => {
        return addressOf(c);
      }),
    ).toEqual(["a/x"]);
  });

  test("a card that names another app than its announcement is ignored", async () => {
    const forged = card({ app: "victim", agentId: "secret", share: "team" });
    const { fake } = reading([[event("e", "attacker", [forged])]]);

    expect(await readCards(fake)).toEqual([]);
  });
});

describe("the tools", () => {
  const registered = [
    card({ app: "other-app", agentId: "docs", share: "team", does: "Docs" }),
    card({ app: "other-app", agentId: "hidden", share: "private" }),
    card({ app: testClientId, agentId: "mine", share: "private" }),
  ];

  const runTool = async (name: string, input: Record<string, unknown>) => {
    const tools = discoveryTools();
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

        return resolved.invoke({
          signal: new AbortController().signal,
          idempotencyKey: "k",
        });
      },
    );

    return runFnWithStack(
      fn,
      {},
      { event: { name: "foo", data: {} } as never },
    );
  };

  beforeEach(() => {
    vi.spyOn(client, "listEvents").mockResolvedValue([
      {
        id: "e1",
        internalId: "e1",
        name: agentsRegisteredEvent,
        data: { app: "other-app", cards: registered.slice(0, 2) },
      },
      {
        id: "e2",
        internalId: "e2",
        name: agentsRegisteredEvent,
        data: { app: testClientId, cards: registered.slice(2) },
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("list_agents lists the agents shared with the caller", async () => {
    const result = await runTool("list_agents", {});

    const agentsListed = (
      result as { data: { agents: { id: string }[] } }
    ).data.agents.map((a) => {
      return a.id;
    });

    expect(agentsListed).toEqual(["other-app/docs", `${testClientId}/mine`]);
  });

  test("describe_agent refuses an agent that is not shared", async () => {
    const result = await runTool("describe_agent", { id: "other-app/hidden" });

    expect(JSON.stringify(result)).toMatch(/is shared with you/);
  });

  test("call_agent checks sharing in a step before it invokes", async () => {
    const result = await runTool("call_agent", {
      id: "other-app/hidden",
      input: { message: "hi" },
    });

    expect(JSON.stringify(result)).toMatch(/is shared with you/);
  });
});

describe("announcing", () => {
  test("functions() has the heartbeat, and announce sends the cards", async () => {
    const send = vi.spyOn(client, "send").mockResolvedValue({ ids: [] });

    expect(
      agents.functions().map((fn) => {
        return fn.id(testClientId);
      }),
    ).toContain(`${testClientId}-agents-announce`);

    await agents.announce();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: agentsRegisteredEvent,
        data: expect.objectContaining({
          app: testClientId,
          cards: expect.arrayContaining([
            expect.objectContaining({ agentId: "docs" }),
          ]),
        }),
      }),
    );
    send.mockRestore();
  });
});
