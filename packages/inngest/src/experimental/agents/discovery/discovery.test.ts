/**
 * @module
 * Tests for agent discovery: the card an agent makes, the cron that announces
 * it, how the current cards are read back and the two discovery tools.
 */
import { z } from "zod/v4";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { Inngest, internalLoggerSymbol } from "../../../components/Inngest.ts";
import { resolveToolCall } from "../../../components/sandbox/tools.ts";
import { invoke } from "../../../components/triggers/triggers.ts";
import { createFnRunner, testClientId } from "../../../test/helpers.ts";
import * as agentsApi from "../agent/agents.ts";
import { createAgents } from "../agent/agents.ts";
import { agentToolSet } from "../agent/agentTools.ts";
import { signCards } from "../agent/relations.ts";
import { memoryKvAdapter, setAppKvStore } from "../kv/kv.ts";
import {
  type AnnouncedCard,
  addressOf,
  agentsRegisteredEvent,
  announceCron,
  announcement,
  cardsFreshMs,
  currentCards,
  discoveryToolSet,
  discoveryToolsFor,
  matchesDiscovery,
  mayUse,
  prepareInput,
  publicCardOf,
  readCards,
  validateDiscoveryList,
} from "./discovery.ts";

const client = new Inngest({ id: testClientId });

// What an app's announcement carries: its cards and the signature over them.
// The fake clients below have no signing key, like the real one in this file.
const signedData = (app: string, cards: AnnouncedCard[]) => {
  return { app, cards, sig: signCards({ id: app } as Inngest.Any, cards) };
};
setAppKvStore(client.id, memoryKvAdapter());
const agents = createAgents(client);

const docs = agents.agent(
  {
    id: "docs",
    card: {
      description: "Answers questions about the docs",
      tags: ["docs", "support"],
      share: "team",
      owner: "docs-team",
      effects: "read",
      speed: "seconds",
    },
    triggers: invoke(z.object({ question: z.string() })),
  },
  async () => {
    return { answer: "read the docs" };
  },
);

const secret = agents.agent({ id: "secret" }, async () => {
  return null;
});

const described = agents.agent(
  { id: "described", description: "From the function option" },
  async () => {
    return null;
  },
);

// A card whose description is in parts.
const triage = agents.agent(
  {
    id: "triage",
    card: {
      description: {
        does: "Routes a support request to the right team",
        use: "when you do not know who should handle a request",
        avoid: "for requests you can answer yourself",
      },
      share: "team",
      effects: "read",
    },
    triggers: invoke(z.object({ request: z.string() })),
  },
  async () => {
    return { team: "billing" };
  },
);

const triageText =
  "Routes a support request to the right team. Use it when you do not know who should handle a request. Don't use it for requests you can answer yourself.";

const card = (over: Partial<AnnouncedCard> & { address: string }) => {
  return {
    share: "private",
    effects: "write",
    capabilities: [],
    ...over,
  } as AnnouncedCard;
};

describe("an agent's card", () => {
  test("a string description is kept as written", () => {
    expect(docs.card.description).toBe("Answers questions about the docs");
  });

  test("a description in parts is announced as the rendered string", () => {
    expect(triage.card.description).toBe(triageText);

    const announced = announcement(client).data.cards.find((c) => {
      return c.address === `${testClientId}/triage`;
    });

    expect(announced?.description).toBe(triageText);
    expect(announced).not.toHaveProperty("context");
  });

  test("parts render like a tool's: clauses get their lead, whole sentences stay", () => {
    const made = agents.agent(
      {
        id: "phrased",
        card: {
          description: {
            does: "Does a thing",
            use: "Only for things",
            avoid: "Never for other things",
          },
        },
      },
      async () => {
        return {};
      },
    );

    expect(made.card.description).toBe(
      "Does a thing. Only for things. Never for other things.",
    );
  });

  test("a description with only `does` is one sentence", () => {
    const made = agents.agent(
      { id: "plain-parts", card: { description: { does: "Does it" } } },
      async () => {
        return {};
      },
    );

    expect(made.card.description).toBe("Does it.");
  });

  test("is made from the card field and the invoke() trigger", () => {
    expect(docs.card).toEqual({
      source: expect.objectContaining({
        file: expect.stringMatching(/discovery\.test\.ts$/),
      }),
      address: `${testClientId}/docs`,
      description: "Answers questions about the docs",
      input: expect.objectContaining({ required: ["question"] }),
      tags: ["docs", "support"],
      // No card.capabilities was given, so it is derived from tags.
      capabilities: ["docs", "support"],
      share: "team",
      owner: "docs-team",
      effects: "read",
      speed: "seconds",
    });
  });

  test("without a card field it is private, write and has only its address", () => {
    expect(secret.card).toEqual({
      source: expect.objectContaining({ line: expect.any(Number) }),
      address: `${testClientId}/secret`,
      share: "private",
      effects: "write",
      // No capabilities and no tags to derive them from.
      capabilities: [],
    });
  });

  test("a card without capabilities derives them from tags, and warns", () => {
    const warn = vi.spyOn(client[internalLoggerSymbol], "warn");

    const derived = agents.agent(
      { id: "derives-caps", card: { tags: ["billing", "refunds"] } },
      async () => {
        return null;
      },
    );

    expect(derived.card.capabilities).toEqual(["billing", "refunds"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: `${testClientId}/derives-caps` }),
      expect.stringContaining("capabilities"),
    );
    warn.mockRestore();
  });

  test("a card with its own capabilities uses them, not the tags", () => {
    const made = agents.agent(
      {
        id: "has-caps",
        card: {
          capabilities: ["billing questions"],
          tags: ["billing"],
        },
      },
      async () => {
        return null;
      },
    );

    expect(made.card.capabilities).toEqual(["billing questions"]);
    expect(made.card.tags).toEqual(["billing"]);
  });

  test("the description falls back to the function's own description", () => {
    expect(described.card.description).toBe("From the function option");
    expect(docs.card.description).toBe("Answers questions about the docs");
  });

  test("a schema that is not JSON Schema capable still marks typed input", () => {
    const typed = agents.agent(
      {
        id: "legacy",
        triggers: invoke({
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

    expect(typed.card.input).toEqual({ type: "object" });
  });
});

describe("announcing", () => {
  test("a cron every 6 hours is the only announcer", () => {
    const announcer = agents.functions().find((fn) => {
      return fn.id(testClientId) === `${testClientId}-agents-announce`;
    });

    expect(announceCron).toBe("0 */6 * * *");
    expect(announcer?.opts.triggers).toEqual([{ cron: announceCron }]);
  });

  test("announce() and the announce event are gone", () => {
    expect("announce" in agents).toBe(false);
    expect("agentsAnnounceEvent" in agentsApi).toBe(false);
    expect("discoveryTools" in agentsApi).toBe(false);
    expect("findAgents" in agentsApi).toBe(false);
    expect("callAgent" in agentsApi).toBe(false);
  });

  test("the event carries the app's own cards", () => {
    const event = announcement(client);

    expect(event.name).toBe(agentsRegisteredEvent);
    expect(event.data.app).toBe(testClientId);
    expect(
      event.data.cards.map((c) => {
        return c.address;
      }),
    ).toEqual(
      expect.arrayContaining([
        `${testClientId}/docs`,
        `${testClientId}/secret`,
      ]),
    );
  });
});

describe("sharing and matching", () => {
  const a = card({ address: "a/x", share: "private" });
  const b = card({ address: "b/y", share: "team" });

  test("a private agent is for its own app, a team agent for all", () => {
    expect(mayUse(a, "a")).toBe(true);
    expect(mayUse(a, "b")).toBe(false);
    expect(mayUse(b, "a")).toBe(true);
  });

  test("addressOf reads a card's address", () => {
    expect(addressOf(a)).toBe("a/x");
  });

  test("a card without tags publishes none, and empty tags are dropped", () => {
    const untagged = agents.agent(
      { id: "untagged", card: { tags: [] } },
      async () => {
        return null;
      },
    );

    expect("tags" in secret.card).toBe(false);
    expect("tags" in untagged.card).toBe(false);
  });
});

describe("reading the current cards", () => {
  const event = (
    id: string,
    app: string,
    cards: AnnouncedCard[],
    ts?: number,
  ) => {
    return {
      id,
      internalId: id,
      name: agentsRegisteredEvent,
      data: signedData(app, cards),
      ts: ts ?? Date.now(),
    };
  };
  const fakeClient = (parts: {
    listEvents?: (options: { cursor?: string }) => Promise<unknown[]>;
    queryInsights?: () => Promise<{ columns: string[]; rows: unknown[][] }>;
  }) => {
    return {
      id: "reader",
      listEvents: vi.fn(parts.listEvents ?? (async () => [])),
      queryInsights: vi.fn(
        parts.queryInsights ??
          (async () => {
            throw new Error("Insights query failed: 501 Not Implemented - no");
          }),
      ),
    } as unknown as Inngest.Any;
  };

  test("keeps the newest card of each agent, so fewer cards do not hide others", async () => {
    const x = card({ address: "a/x", description: "fresh" });
    const oldX = card({ address: "a/x", description: "old" });
    const y = card({ address: "a/y" });
    const reader = fakeClient({
      listEvents: async () => {
        return [event("new", "a", [x]), event("old", "a", [oldX, y])];
      },
    });
    const cards = await readCards(reader);

    expect(
      cards.map((c) => {
        return `${c.address}:${c.description ?? ""}`;
      }),
    ).toEqual(["a/x:fresh", "a/y:"]);
  });

  test("a card that names another app than its announcement is dropped", async () => {
    const reader = fakeClient({
      listEvents: async () => {
        return [
          event("e", "attacker", [
            card({ address: "victim/secret", share: "team" }),
          ]),
        ];
      },
    });

    expect(await readCards(reader)).toEqual([]);
  });

  test("pages through events until the 24-hour window ends", async () => {
    const day = 24 * 60 * 60 * 1000;
    const listEvents = vi.fn(async ({ cursor }: { cursor?: string }) => {
      if (!cursor) {
        return Array.from({ length: 50 }, (_, index) => {
          return event(`e${index}`, `filler${index}`, []);
        });
      }

      return [
        event("in", "a", [card({ address: "a/x" })]),
        event("late", "b", [card({ address: "b/y" })], Date.now() - 2 * day),
      ];
    });
    const reader = fakeClient({ listEvents });
    const cards = await readCards(reader);

    expect(listEvents.mock.calls[1]?.[0]).toMatchObject({ cursor: "e49" });
    expect(
      cards.map((c) => {
        return c.address;
      }),
    ).toEqual(["a/x"]);
  });

  test("reads with one Insights query when the server answers it", async () => {
    const x = card({ address: "a/x", description: "from insights" });
    const reader = fakeClient({
      queryInsights: async () => {
        return {
          columns: ["data"],
          rows: [[JSON.stringify(signedData("a", [x]))]],
        };
      },
    });
    const cards = await readCards(reader);

    expect(cards).toEqual([x]);
    expect(reader.listEvents).not.toHaveBeenCalled();
  });

  test("falls back to listEvents on a 501 and only on a 501", async () => {
    const fell = fakeClient({
      listEvents: async () => {
        return [event("e", "a", [card({ address: "a/x" })])];
      },
    });

    expect(await readCards(fell)).toHaveLength(1);
    expect(fell.queryInsights).toHaveBeenCalledTimes(1);

    const broken = fakeClient({
      queryInsights: async () => {
        throw new Error("Insights query failed: 500 Server Error - boom");
      },
    });

    await expect(readCards(broken)).rejects.toThrow(/boom/);
    expect(broken.listEvents).not.toHaveBeenCalled();
  });

  test("a full 1000-row answer is read, not an error, and warns", async () => {
    const reader = fakeClient({
      queryInsights: async () => {
        return {
          columns: ["data"],
          rows: Array.from({ length: 1000 }, () => {
            return [JSON.stringify({ app: "a", cards: [] })];
          }),
        };
      },
    });

    await expect(readCards(reader)).resolves.toEqual([]);
  });
});

describe("paused and gone agents", () => {
  const reader = (cards: AnnouncedCard[], app = "other") => {
    return {
      id: testClientId,
      listEvents: vi.fn(async () => {
        return [
          {
            id: "e",
            internalId: "e",
            name: agentsRegisteredEvent,
            data: signedData(app, cards),
            ts: Date.now(),
          },
        ];
      }),
      queryInsights: vi.fn(async () => {
        throw new Error("Insights query failed: 501 Not Implemented - no");
      }),
    } as unknown as Inngest.Any;
  };

  test("a paused function is marked and a missing one is dropped", async () => {
    const cards = [
      card({ address: "other/live", share: "team" }),
      card({ address: "other/paused", share: "team" }),
      card({ address: "other/gone", share: "team" }),
      card({ address: "other/archived", share: "team" }),
    ];
    const found = await currentCards(reader(cards), {
      functions: async () => {
        return new Map([
          ["live", { paused: false, archived: false }],
          ["paused", { paused: true, archived: false }],
          ["archived", { paused: false, archived: true }],
        ]);
      },
    });

    expect(
      found
        .filter((c) => {
          return c.address.startsWith("other/");
        })
        .map((c) => {
          return `${c.address}${c.paused ? ":paused" : ""}`;
        }),
    ).toEqual(["other/live", "other/paused:paused", "other/archived:paused"]);
  });

  test("the app's own agents come from their definitions at once", async () => {
    const found = await currentCards(reader([]), {
      functions: async () => {
        return new Map();
      },
    });

    expect(
      found.map((c) => {
        return c.address;
      }),
    ).toEqual(
      expect.arrayContaining([
        `${testClientId}/docs`,
        `${testClientId}/secret`,
      ]),
    );
  });
});

describe("the tools", () => {
  const registered = [
    card({
      address: "other-app/docs",
      share: "team",
      description: "Docs",
      input: { type: "object" },
      effects: "read",
    }),
    card({ address: "other-app/hidden", share: "private" }),
    card({ address: "other-app/writer", share: "team", tags: ["sdk"] }),
    card({
      address: "other-app/special",
      share: "team",
      effects: "read",
      explicit: true,
    }),
  ];
  let reads = 0;

  const runTools = async (
    calls: { name: string; input: Record<string, unknown> }[],
    options: Parameters<typeof discoveryToolSet>[0] = {},
    self?: string, // the address of the agent that calls, if it is one
  ) => {
    const tools = discoveryToolSet(options);
    const fn = client.createFunction(
      { id: "caller", triggers: [{ event: "foo" }] },
      async () => {
        const out: unknown[] = [];
        const execution = getAsyncCtxSync()?.execution;

        if (self && execution) {
          execution.agent = { thread: "t1", ref: self };
        }

        for (const { name, input } of calls) {
          const resolved = await resolveToolCall(
            tools,
            { op: "call", id: 1, tool: name, args: [], kwargs: input },
            JSON.stringify(input),
          );

          if (resolved.error !== undefined) {
            out.push({ error: resolved.error });
            continue;
          }

          try {
            out.push(
              await resolved.invoke({
                signal: new AbortController().signal,
                idempotencyKey: "k",
              }),
            );
          } catch (error) {
            out.push({ error: String(error) });
          }
        }

        return out;
      },
    );

    const run = createFnRunner(fn, {
      event: { name: "foo", data: {} } as never,
    });

    for (let pass = 0; pass < 40; pass++) {
      const result = await run();

      if (result.result?.type === "function-resolved") {
        return result.result;
      }
    }

    throw new Error("the function did not finish");
  };
  const listed = (result: unknown, index = 0) => {
    const outputs = (result as { data: unknown[] }).data;

    return (outputs[index] as { agents: { address: string }[] }).agents.map(
      (a) => {
        return a.address;
      },
    );
  };

  beforeEach(() => {
    reads = 0;
    vi.spyOn(client, "queryInsights").mockImplementation(async () => {
      reads++;
      throw new Error("Insights query failed: 501 Not Implemented - no");
    });
    vi.spyOn(client, "listEvents").mockResolvedValue([
      {
        id: "e1",
        internalId: "e1",
        name: agentsRegisteredEvent,
        data: signedData("other-app", registered),
        ts: Date.now(),
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("list_agents never lists the agent that calls, which can still describe itself", async () => {
    const result = await runTools(
      [
        { name: "list_agents", input: {} },
        { name: "describe_agent", input: { address: `${testClientId}/docs` } },
      ],
      {
        functions: async () => {
          return new Map([["docs", { paused: false, archived: false }]]);
        },
      },
      `${testClientId}/docs`,
    );

    expect(listed(result)).not.toContain(`${testClientId}/docs`);
    expect(listed(result)).toContain("other-app/docs");
    expect((result as { data: unknown[] }).data[1]).toMatchObject({
      address: `${testClientId}/docs`,
    });
  });

  test("list_agents returns everyone visible, with no query to narrow it, and says so", async () => {
    const tools = discoveryToolSet();

    expect(JSON.stringify(tools.list_agents.description)).toMatch(
      /whole list/i,
    );
    expect(JSON.stringify(tools.list_agents.input)).not.toMatch(/query/);
  });

  test("list_agents' answer carries ttlMs and cacheScope: private", async () => {
    const result = await runTools([{ name: "list_agents", input: {} }], {
      functions: async () => {
        return new Map([["docs", { paused: false, archived: false }]]);
      },
    });
    const [roster] = (result as { data: unknown[] }).data as [
      { ttlMs: number; cacheScope: string },
    ];

    expect(roster.ttlMs).toBe(cardsFreshMs);
    expect(roster.cacheScope).toBe("private");
  });

  test("list_agents and describe_agent show a description in parts as one paragraph", async () => {
    const result = await runTools(
      [
        { name: "list_agents", input: {} },
        {
          name: "describe_agent",
          input: { address: `${testClientId}/triage` },
        },
      ],
      {
        functions: async () => {
          return new Map([["triage", { paused: false, archived: false }]]);
        },
      },
      `${testClientId}/docs`,
    );
    const data = (result as { data: unknown[] }).data;
    const listedAgents = (
      data[0] as { agents: { address: string; description?: string }[] }
    ).agents;

    expect(
      listedAgents.find((a) => {
        return a.address === `${testClientId}/triage`;
      })?.description,
    ).toBe(triageText);
    expect(data[1]).toMatchObject({
      address: `${testClientId}/triage`,
      description: triageText,
    });
  });

  test("list_agents lists same-app agents and shared ones of other apps", async () => {
    const result = await runTools([{ name: "list_agents", input: {} }], {
      functions: async () => {
        return new Map([
          ["docs", { paused: false, archived: false }],
          ["hidden", { paused: false, archived: false }],
        ]);
      },
    });

    expect(listed(result)).toEqual(
      expect.arrayContaining([
        "other-app/docs",
        `${testClientId}/docs`,
        `${testClientId}/secret`,
      ]),
    );
    expect(listed(result)).not.toContain("other-app/hidden");
  });

  const everyone = async () => {
    return new Map(
      ["docs", "hidden", "writer", "special"].map((id) => {
        return [id, { paused: false, archived: false }] as const;
      }),
    );
  };

  test("by default other apps show only read-only agents, and never an explicit one", async () => {
    const result = await runTools([{ name: "list_agents", input: {} }], {
      functions: everyone,
    });

    expect(listed(result)).toContain("other-app/docs");
    expect(listed(result)).not.toContain("other-app/writer");
    expect(listed(result)).not.toContain("other-app/special");
  });

  test("discovery.agents decides what is listed and described", async () => {
    const result = await runTools(
      [
        { name: "list_agents", input: {} },
        { name: "describe_agent", input: { address: "other-app/docs" } },
        { name: "describe_agent", input: { address: "other-app/writer" } },
      ],
      {
        functions: everyone,
        discovery: { agents: [{ tags: ["sdk"] }, "other-app/special"] },
      },
    );
    const [, refused, allowed] = (result as { data: unknown[] }).data;

    expect(listed(result).sort()).toEqual([
      "other-app/special",
      "other-app/writer",
    ]);
    expect(JSON.stringify(refused)).toMatch(/is shared with you/);
    expect(JSON.stringify(allowed)).toMatch(/other-app\/writer/);
  });

  test("describe_agent gives the whole card; an unshared address reads like an unknown one", async () => {
    const result = await runTools(
      [
        { name: "describe_agent", input: { address: "other-app/docs" } },
        { name: "describe_agent", input: { address: "other-app/hidden" } },
        { name: "describe_agent", input: { address: "other-app/nope" } },
      ],
      {
        functions: async () => {
          return new Map([
            ["docs", { paused: false, archived: false }],
            ["hidden", { paused: false, archived: false }],
          ]);
        },
      },
    );
    const [whole, hidden, unknown] = (result as { data: unknown[] }).data;

    expect(JSON.stringify(whole)).toMatch(/"input"/);
    expect(JSON.stringify(hidden)).toMatch(/is shared with you/);
    expect(JSON.stringify(unknown)).toMatch(/is shared with you/);
    // The card the model sees carries no roster inputs: a reader can never
    // learn `share`/`explicit` from the card itself, only from being let
    // through or not.
    expect(whole).not.toHaveProperty("share");
    expect(whole).not.toHaveProperty("explicit");
  });

  test("a read is reused for 30 seconds, then read again; refresh is ignored", async () => {
    let clock = 1_000_000;
    let advance = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      return clock;
    });
    const options = {
      functions: async () => {
        // Each read takes `advance` of the clock with it.
        clock += advance;

        return new Map([["docs", { paused: false, archived: false }]]);
      },
    };

    try {
      await runTools(
        [
          { name: "list_agents", input: {} },
          { name: "list_agents", input: { refresh: true } },
          { name: "describe_agent", input: { address: "other-app/docs" } },
        ],
        options,
      );
      expect(reads).toBe(1);

      reads = 0;
      advance = cardsFreshMs;
      await runTools(
        [
          { name: "list_agents", input: {} },
          { name: "list_agents", input: {} },
        ],
        options,
      );
      expect(reads).toBe(2);
    } finally {
      now.mockRestore();
    }
  });
});

describe("the tools run as groups", () => {
  test("list_agents and describe_agent use steps, so neither runs inside a step of its own", () => {
    const tools = discoveryToolSet();

    expect(tools.list_agents).toMatchObject({ group: true });
    expect(tools.describe_agent).toMatchObject({ group: true });
  });

  test("start_agent and stop_agent are groups too", () => {
    const tools = agentToolSet();

    expect(tools.start_agent).toMatchObject({ group: true });
    expect(tools.stop_agent).toMatchObject({ group: true });
  });
});

describe("discovery on the definition", () => {
  test("discovery is opt-in: true or options give both tools, nothing else does", () => {
    expect(Object.keys(discoveryToolsFor(false))).toEqual([]);
    expect(Object.keys(discoveryToolsFor(undefined))).toEqual([]);
    expect(Object.keys(discoveryToolsFor(true)).sort()).toEqual([
      "describe_agent",
      "list_agents",
    ]);
    expect(Object.keys(discoveryToolsFor({})).sort()).toEqual([
      "describe_agent",
      "list_agents",
    ]);
  });

  test("prepare fills the input and gets the card, input, event and thread", async () => {
    const target = card({ address: "other/docs" });
    const prepare = vi.fn(({ input }: { input: Record<string, string> }) => {
      return { ...input, origin: "web" };
    });
    let prepared: unknown;
    const fn = client.createFunction(
      { id: "prepares", triggers: [{ event: "foo" }] },
      async () => {
        prepared = await prepareInput(
          { prepare: prepare as never },
          { card: target, input: { q: "hi" } },
        );
      },
    );
    const run = createFnRunner(fn, {
      event: { name: "foo", data: { n: 1 } } as never,
    });

    await run();

    expect(prepared).toEqual({ q: "hi", origin: "web" });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        card: target,
        input: { q: "hi" },
        event: expect.objectContaining({ name: "foo" }),
        thread: { key: "" },
      }),
    );
  });

  test("without prepare the model's input is used as it is", async () => {
    const input = { q: "hi" };

    expect(
      await prepareInput({}, { card: card({ address: "a/b" }), input }),
    ).toBe(input);
  });
});

describe("publicCardOf", () => {
  test("strips the roster inputs, keeping the rest of the card", () => {
    const announced = card({
      address: "a/b",
      share: "team",
      explicit: true,
      description: "Does a thing",
    });

    expect(publicCardOf(announced)).toEqual({
      address: "a/b",
      capabilities: [],
      effects: "write",
      description: "Does a thing",
    });
  });
});

describe("matchesDiscovery", () => {
  const entry = card({
    address: "platform/reviewer",
    tags: ["sdk", "ci"],
    owner: "platform",
    effects: "read",
  });
  const as = { appId: "x" };

  test("a filter needs every field; a list needs one entry; self is the caller's app", () => {
    const both = [{ app: "platform", effects: "read" as const }];
    const wrong = [{ app: "platform", effects: "write" as const }];

    expect(matchesDiscovery(entry, both, as)).toBe(true);
    expect(matchesDiscovery(entry, wrong, as)).toBe(false);
    expect(matchesDiscovery(entry, [{ tags: ["sdk", "ci"] }, "o/a"], as)).toBe(
      true,
    );
    expect(matchesDiscovery(entry, [{ tags: ["sdk", "no"] }], as)).toBe(false);
    expect(
      matchesDiscovery(entry, [{ app: "self" }], { appId: "platform" }),
    ).toBe(true);
    expect(matchesDiscovery(entry, [{ app: "self" }], as)).toBe(false);
    expect(matchesDiscovery(entry, [], as)).toBe(false);
  });

  test("a card without effects counts as write", () => {
    expect(
      matchesDiscovery({ address: "a/b" }, [{ effects: "write" }], as),
    ).toBe(true);
  });

  test("an explicit card matches only an agent or its address", () => {
    const hidden = { ...entry, explicit: true };

    expect(matchesDiscovery(hidden, [{ app: "platform" }], as)).toBe(false);
    expect(matchesDiscovery(hidden, ["platform/reviewer"], as)).toBe(true);
    expect(
      matchesDiscovery(hidden, [{ address: "platform/reviewer" }], as),
    ).toBe(true);
  });

  test("a malformed list is refused when validated", () => {
    expect(() => validateDiscoveryList("a", "agents", [{}])).toThrow(
      /empty filter/,
    );
    expect(() => validateDiscoveryList("a", "agents", ["nope"])).toThrow(
      /app\/name/,
    );
    expect(() => validateDiscoveryList("a", "tools", [{ tag: ["x"] }])).toThrow(
      /"tag"/,
    );
    expect(() =>
      validateDiscoveryList("a", "agents", [{ app: "self" }, "a/b"]),
    ).not.toThrow();
  });
});
