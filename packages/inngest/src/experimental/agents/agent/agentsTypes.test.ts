/**
 * @module
 * Type tests for the public entry `inngest/experimental/agents`.
 */

import { z } from "zod";
import { invoke } from "../../../components/triggers/triggers.ts";
import * as entry from "../index.ts";
import type { AgentModelResponse } from "../loop/loop.ts";
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
        expectTypeOf(score).toEqualTypeOf<
          (name: string, value: number | boolean) => Promise<void>
        >();
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
    });
  });
});

test("agents: me has a key and no post", () => {
  typesOnly(() => {
    agents.agent({ id: "me-1", triggers: [created] }, async ({ me }) => {
      expectTypeOf(me.key).toBeString();
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
        model: async (): Promise<AgentModelResponse> => {
          return { message: { role: "assistant", content: [] }, toolCalls: [] };
        },
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
