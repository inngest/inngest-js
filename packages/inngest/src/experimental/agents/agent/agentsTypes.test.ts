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

test("agents: the handler argument is event, inbox, thread, sandboxes and score", () => {
  typesOnly(() => {
    agents.agent(
      { id: "arg-1", triggers: [created] },
      async ({ event, inbox, thread, sandboxes, score }) => {
        expectTypeOf(event).toHaveProperty("name");
        expectTypeOf(inbox).toHaveProperty("next");
        expectTypeOf(thread).toHaveProperty("key");
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

      // @ts-expect-error scores is score
      void context.scores;
    });
  });
});

test("agents: thread has message and key, and no post", () => {
  typesOnly(() => {
    agents.agent(
      { id: "thread-1", triggers: [created] },
      async ({ thread }) => {
        expectTypeOf(thread.key).toBeString();
        expectTypeOf(thread.message).parameter(0).toExtend<Json>();
        expectTypeOf(thread.message("x")).toEqualTypeOf<Promise<void>>();
        expectTypeOf(thread).not.toHaveProperty("post");
      },
    );
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

test("agents: limits.spawn is an error", () => {
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
      // @ts-expect-error budget is gone
      budget: { usd: 1 },
    });

    agents.agent({
      id: "limits-gone-3",
      triggers: [created],
      // @ts-expect-error price is gone
      price: { "*": { input: 1, output: 1 } },
    });
  });
});

test("agents: previousRun is the last run's outcome", () => {
  typesOnly(() => {
    agents.agent({
      id: "recover-2",
      triggers: [created],
      // @ts-expect-error recovery is gone
      recovery: true,
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

test("agents: agents.agent returns an Agent with an id, an address and a card", () => {
  typesOnly(() => {
    const found = agents.agent({ id: "ret-1", triggers: [created] });

    expectTypeOf(found.id).toBeString();
    expectTypeOf(found.address).toBeString();
    expectTypeOf(found.card).toEqualTypeOf<entry.AnnouncedCard>();
    expectTypeOf(found).toHaveProperty("start");
    expectTypeOf(found).toHaveProperty("thread");
  });
});
