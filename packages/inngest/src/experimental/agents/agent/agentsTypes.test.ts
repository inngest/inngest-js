/**
 * @module
 * Type tests for the public entry `inngest/experimental/agents`.
 */
import { z } from "zod";
import { invoke } from "../../../components/triggers/triggers.ts";
import * as entry from "../index.ts";
import { agents, created, typesOnly } from "./typeFixtures.ts";

const deletedValues = [
  "listThreads",
  "agentInvokeCancelOn",
  "agentInvokeDepth",
  "agentInvokeInput",
  "skills",
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
