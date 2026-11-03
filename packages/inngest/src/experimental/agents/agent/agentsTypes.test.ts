/**
 * @module
 * Type tests for the public entry `inngest/experimental/agents`.
 */

import { z } from "zod";
import { invoke } from "../../../components/triggers/triggers.ts";
import * as entry from "../index.ts";
import type { Json } from "../json.ts";
import { type AgentModelResponse, agentModel } from "../loop/loop.ts";
import { agents, closed, created, typesOnly } from "./typeFixtures.ts";

const deletedValues = [
  "listThreads",
  "agentInvokeCancelOn",
  "agentInvokeDepth",
  "agentInvokeInput",
  "skillsBake",
  "createKv",
  "slack",
  "github",
  "githubApp",
  "GithubAppError",
  "GithubAppNotInstalledError",
  "askThrough",
  "defineChannel",
  "ChannelStreamEnded",
  "slackMessageEvent",
  "githubCommentEvent",
  "agentRequest",
  "agentRequestEvent",
] as const;

type DeletedNames =
  | (typeof deletedValues)[number]
  | "ThreadList"
  | "ThreadListOptions"
  | "InsightsQuery"
  | "InvokeInput"
  | "AgentInvokeOptions"
  | "AgentToolInput"
  | "AgentMessageInput"
  | "AgentArrivalContext"
  | "ThreadRequests"
  | "RequestOptions"
  | "AgentRequestData"
  | "SkillsSource"
  | "SkillsGitOptions"
  | "AgentSkill"
  | "Channel"
  | "ChannelAsk"
  | "ChannelMessage"
  | "Reporter"
  | "ReportConfig"
  | "RunFailure";

test("agents: the deleted names are not exported", () => {
  // The names are values or types of the entry: none is a key of it.
  expectTypeOf<keyof typeof entry & DeletedNames>().toEqualTypeOf<never>();

  for (const name of deletedValues) {
    expect(Object.keys(entry)).not.toContain(name);
  }

  expect(Object.keys(entry.agent)).not.toContain("invoke");

  const defined = agents.agent({ id: "gone" }, async () => {
    return null;
  });

  expectTypeOf(defined).not.toHaveProperty("threads");
  expectTypeOf(defined).not.toHaveProperty("~tool");
  expectTypeOf(defined).not.toHaveProperty("arrival");
});

test("agents: triggers take what createFunction triggers take", () => {
  typesOnly(() => {
    agents.agent({
      id: "triggers-1",
      triggers: [
        created,
        { event: "order/refunded", if: "event.data.total > 10" },
        { cron: "0 * * * *" },
        invoke(z.object({ task: z.string() })),
      ],
    });

    // @ts-expect-error `on` was renamed to `triggers`
    agents.agent({ id: "triggers-2", on: created });
  });
});

test("agents: idle takes a duration or a function of the run's start, and nothing else", () => {
  typesOnly(() => {
    agents.agent({ id: "idle-1", triggers: [created], idle: 5000 });
    agents.agent({ id: "idle-2", triggers: [created], idle: "7d" });
    agents.agent({
      id: "idle-3",
      triggers: [created],
      idle: async ({ event, thread }) => {
        expectTypeOf(event.name).toEqualTypeOf<"order/created">();
        expectTypeOf(thread).toEqualTypeOf<{ key: string }>();

        return "2m";
      },
    });

    // @ts-expect-error idle is a duration
    agents.agent({ id: "idle-4", triggers: [created], idle: true });
  });
});

test("agents: listen takes event types and inboxTools is gone", () => {
  typesOnly(() => {
    agents.agent({ id: "listen-1", triggers: [created], listen: [created] });

    // @ts-expect-error listen takes event types, not names
    agents.agent({ id: "listen-2", triggers: [created], listen: ["order/x"] });

    // @ts-expect-error inboxTools became `listen`
    agents.agent({ id: "listen-3", triggers: [created], inboxTools: {} });
  });
});

test("agents: event is the trigger event, narrowed per trigger by is()", () => {
  typesOnly(() => {
    agents.agent(
      { id: "event-1", triggers: [created, closed] },
      async ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<
          "order/created" | "order/closed"
        >();

        if (event.is(created)) {
          expectTypeOf(event.data).toEqualTypeOf<{
            id: string;
            total: number;
          }>();
        }

        if (event.is(closed)) {
          expectTypeOf(event.data).toEqualTypeOf<{ id: string }>();
        }
      },
    );
  });
});

test("agents: a trigger with no schema has data of Record<string, any>", () => {
  typesOnly(() => {
    agents.agent(
      { id: "event-2", triggers: [{ event: "plain/event" }] },
      async ({ event }) => {
        // The one allowed `any`: the data comes from outside, and core types
        // an event with no schema the same way.
        // biome-ignore lint/suspicious/noExplicitAny: pins the one allowed any
        expectTypeOf(event.data).toEqualTypeOf<Record<string, any>>();
        expectTypeOf(event.data.anything).toBeAny();
      },
    );
  });
});

test("agents: the handler argument is event, inbox, me, sandboxes and score", () => {
  typesOnly(() => {
    agents.agent(
      { id: "arg-1", triggers: [created] },
      async ({ event, inbox, me, sandboxes, score }) => {
        expectTypeOf(event).toHaveProperty("name");
        expectTypeOf(inbox).toHaveProperty("next");
        expectTypeOf(me).toHaveProperty("key");
        expectTypeOf(sandboxes).toBeObject();
        expectTypeOf(score).toBeFunction();
      },
    );
  });
});

test("agents: the old handler fields are gone", () => {
  typesOnly(() => {
    agents.agent({ id: "gone-1", triggers: [created] }, async (context) => {
      // @ts-expect-error trigger is the event
      void context.trigger;

      // @ts-expect-error thread is me
      void context.thread;

      // @ts-expect-error scores is score
      void context.scores;
    });
  });
});

test("agents: me has message and key, and no post", () => {
  typesOnly(() => {
    agents.agent({ id: "me-1", triggers: [created] }, async ({ me }) => {
      expectTypeOf(me.key).toBeString();
      expectTypeOf(me.message).parameter(0).toExtend<Json>();
      expectTypeOf(me.message("x")).toEqualTypeOf<Promise<void>>();
      expectTypeOf(me).not.toHaveProperty("post");
    });
  });
});

test("agents: createAgents takes a store", () => {
  typesOnly(() => {
    expectTypeOf<{ store: entry.KvStore }>().toExtend<
      NonNullable<Parameters<typeof entry.createAgents>[1]>
    >();
  });
});

test("agents: loop is in the handler argument only for an agent with a model", () => {
  typesOnly(() => {
    agents.agent(
      {
        id: "with-model",
        triggers: [created],
        model: agentModel(async (): Promise<AgentModelResponse> => {
          return { message: { role: "assistant", content: [] }, toolCalls: [] };
        }),
      },
      async ({ loop }) => {
        expectTypeOf(loop).toBeFunction();
        expectTypeOf(loop.with).toBeFunction();
      },
    );
    agents.agent({ id: "no-model", triggers: [created] }, async (context) => {
      expectTypeOf(context).not.toHaveProperty("loop");
    });
  });
});

test("agents: budget, price and limits fields take their types", () => {
  typesOnly(() => {
    agents.agent({
      id: "fields-1",
      triggers: [created],
      budget: { usd: 1, tokens: 100 },
      price: { "*": { input: 1, output: 2 } },
      limits: { depth: 2 },
    });

    agents.agent({
      id: "fields-2",
      triggers: [created],
      budget: ({ event, thread }) => {
        expectTypeOf(event).toHaveProperty("name");
        expectTypeOf(thread.key).toBeString();

        return { usd: 1 };
      },
      price: (usage, model) => {
        expectTypeOf(usage.input).toBeNumber();
        expectTypeOf(model).toEqualTypeOf<string | undefined>();

        return 0.01;
      },
    });
  });
});

test("agents: discovery.agents takes imported agents, addresses and filters", () => {
  typesOnly(() => {
    const other = agents.agent({ id: "other", triggers: [created] });

    agents.agent({
      id: "discovery-list-1",
      triggers: [created],
      discovery: {
        agents: [
          other,
          "research/coder",
          { app: "self", effects: "read" },
          { tags: ["sdk"] },
        ],
        tools: [{ tags: ["social"] }],
      },
    });

    agents.agent({
      id: "discovery-list-2",
      triggers: [created],
      // @ts-expect-error an entry is not a number
      discovery: { agents: [1] },
    });

    agents.agent({
      id: "discovery-list-3",
      triggers: [created],
      // @ts-expect-error effects is read or write
      discovery: { agents: [{ effects: "maybe" }] },
    });
  });
});

test("agents: limits.mayCall is gone", () => {
  typesOnly(() => {
    agents.agent({
      id: "may-call-gone",
      triggers: [created],
      // @ts-expect-error mayCall moved to discovery.agents
      limits: { mayCall: ["research/coder"] },
    });
  });
});

test("agents: limits.spawn, limits.budget and limits.price are errors, and price is never a function of the event", () => {
  typesOnly(() => {
    agents.agent({
      id: "limits-gone-1",
      triggers: [created],
      // @ts-expect-error spawn is gone
      limits: { spawn: 1 },
    });

    agents.agent({
      id: "limits-gone-2",
      triggers: [created],
      // @ts-expect-error budget is a field of the agent
      limits: { budget: { usd: 1 } },
    });

    agents.agent({
      id: "limits-gone-3",
      triggers: [created],
      // @ts-expect-error price is a field of the agent
      limits: { price: { "*": { input: 1, output: 1 } } },
    });

    agents.agent({
      id: "price-1",
      triggers: [created],
      // @ts-expect-error price is a value, never a function of the event
      price: ({ event }: { event: unknown }) => {
        void event;

        return 1;
      },
    });
  });
});

test("agents: recovery is a boolean, and previousRun is the last run's outcome", () => {
  typesOnly(() => {
    agents.agent({ id: "recover-1", triggers: [created], recovery: true });

    agents.agent({
      id: "recover-2",
      triggers: [created],
      // @ts-expect-error recovery takes true or false, no options
      recovery: { resume: true },
    });

    agents.agent(
      { id: "recover-3", triggers: [created] },
      async ({ previousRun }) => {
        expectTypeOf(previousRun).toEqualTypeOf<entry.LastRun | undefined>();
        expectTypeOf(previousRun?.status).toEqualTypeOf<
          "completed" | "failed" | "cancelled" | undefined
        >();
      },
    );
  });
});

test("agents: agent/recover is an event type with the failed message", () => {
  typesOnly(() => {
    expectTypeOf(entry.agentRecover.name).toEqualTypeOf<"agent/recover">();
    expectTypeOf<entry.AgentRecoverData>().toHaveProperty("event");
    expectTypeOf<entry.AgentRecoverData["agent"]>().toBeString();
  });
});

test("agents: agents.agent returns an Agent with an id, an address and a card", () => {
  typesOnly(() => {
    const found = agents.agent({ id: "ret-1", triggers: [created] });

    expectTypeOf(found.id).toBeString();
    expectTypeOf(found.address).toBeString();
    expectTypeOf(found.card).toEqualTypeOf<entry.AgentCard>();
    expectTypeOf(found).toHaveProperty("start");
    expectTypeOf(found).toHaveProperty("thread");
  });
});
