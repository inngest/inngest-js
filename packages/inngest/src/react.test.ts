import { z } from "zod/v3";
import { realtime, staticSchema } from "./index.ts";
import { type UseRealtimeResult, useRealtime } from "./react.ts";

// ---------------------------------------------------------------------------
// Shared channel fixtures used across type tests
// ---------------------------------------------------------------------------

const agentChat = realtime.channel({
  name: ({ threadId }: { threadId: string }) => `chat:${threadId}`,
  topics: {
    status: {
      schema: z.object({
        message: z.string(),
        step: z.string().optional(),
      }),
    },
    tokens: {
      schema: z.object({ token: z.string() }),
    },
    artifact: {
      schema: z.object({
        kind: z.enum(["research", "outline", "draft"]),
        title: z.string(),
        body: z.unknown(),
      }),
    },
    usage: {
      schema: staticSchema<{
        inputTokens: number;
        outputTokens: number;
        model: string;
      }>(),
    },
  },
});

type ChatInstance = ReturnType<typeof agentChat>;

// ---------------------------------------------------------------------------
// Basic exports
// ---------------------------------------------------------------------------

describe("react exports", () => {
  test("exports the realtime hook", () => {
    expect(typeof useRealtime).toBe("function");
  });

  test("useRealtime return type includes message-first fields", () => {
    type HookResult = ReturnType<typeof useRealtime>;

    expectTypeOf<HookResult["connectionStatus"]>().toEqualTypeOf<
      "idle" | "connecting" | "open" | "paused" | "closed" | "error"
    >();
    expectTypeOf<HookResult["runStatus"]>().toEqualTypeOf<
      "unknown" | "running" | "completed" | "failed" | "cancelled"
    >();
    expectTypeOf<HookResult["isPaused"]>().toEqualTypeOf<boolean>();
    expectTypeOf<HookResult["pauseReason"]>().toEqualTypeOf<
      "hidden" | "disabled" | null
    >();
    expectTypeOf<HookResult["messages"]["all"]>().toBeArray();
    expectTypeOf<HookResult["messages"]["delta"]>().toBeArray();
    expectTypeOf<HookResult["messages"]["last"]>().not.toBeAny();
    expectTypeOf<HookResult["reset"]>().toBeFunction();
  });
});

// ---------------------------------------------------------------------------
// Per-topic typing on `messages.byTopic`
// ---------------------------------------------------------------------------

describe("useRealtime per-topic typing", () => {
  type Result = UseRealtimeResult<
    ChatInstance,
    readonly ["status", "tokens", "artifact", "usage"]
  >;

  test("messages.byTopic.status?.data is typed to the status schema", () => {
    type StatusData = NonNullable<
      Result["messages"]["byTopic"]["status"]
    >["data"];

    expectTypeOf<StatusData>().toEqualTypeOf<{
      message: string;
      step?: string;
    }>();
    expectTypeOf<StatusData>().not.toBeAny();
  });

  test("messages.byTopic.tokens?.data is typed to the tokens schema", () => {
    type TokensData = NonNullable<
      Result["messages"]["byTopic"]["tokens"]
    >["data"];

    expectTypeOf<TokensData>().toEqualTypeOf<{ token: string }>();
    expectTypeOf<TokensData>().not.toBeAny();
  });

  test("messages.byTopic.artifact?.data is typed to the artifact schema", () => {
    type ArtifactData = NonNullable<
      Result["messages"]["byTopic"]["artifact"]
    >["data"];

    expectTypeOf<ArtifactData>().toHaveProperty("kind");
    expectTypeOf<ArtifactData>().toHaveProperty("title");
    expectTypeOf<ArtifactData>().toHaveProperty("body");
    expectTypeOf<ArtifactData["kind"]>().toEqualTypeOf<
      "research" | "outline" | "draft"
    >();
    expectTypeOf<ArtifactData["title"]>().toEqualTypeOf<string>();
    expectTypeOf<ArtifactData>().not.toBeAny();
  });

  test("messages.byTopic.usage?.data is typed via staticSchema", () => {
    type UsageData = NonNullable<
      Result["messages"]["byTopic"]["usage"]
    >["data"];

    expectTypeOf<UsageData>().toEqualTypeOf<{
      inputTokens: number;
      outputTokens: number;
      model: string;
    }>();
    expectTypeOf<UsageData>().not.toBeAny();
  });

  test("messages.byTopic entries have typed topic field", () => {
    type StatusTopic = NonNullable<
      Result["messages"]["byTopic"]["status"]
    >["topic"];
    type TokensTopic = NonNullable<
      Result["messages"]["byTopic"]["tokens"]
    >["topic"];

    expectTypeOf<StatusTopic>().toEqualTypeOf<"status">();
    expectTypeOf<TokensTopic>().toEqualTypeOf<"tokens">();
  });

  test("messages.byTopic keys are constrained to subscribed topics only", () => {
    type ByTopicKeys = keyof Result["messages"]["byTopic"];
    expectTypeOf<ByTopicKeys>().toEqualTypeOf<
      "status" | "tokens" | "artifact" | "usage"
    >();
  });
});

// ---------------------------------------------------------------------------
// Discriminated union narrowing on message collections
// ---------------------------------------------------------------------------

describe("discriminated union narrowing on messages", () => {
  type Result = UseRealtimeResult<
    ChatInstance,
    readonly ["status", "tokens", "artifact"]
  >;

  test("messages.all items are a discriminated union by topic", () => {
    type MessageItem = Result["messages"]["all"][number];

    expectTypeOf<MessageItem>().not.toBeAny();
  });

  test("narrowing by topic gives the correct data type", () => {
    type MessageItem = Result["messages"]["all"][number];

    type StatusItem = Extract<MessageItem, { topic: "status"; kind: "data" }>;
    type StatusData = StatusItem["data"];

    expectTypeOf<StatusData>().toEqualTypeOf<{
      message: string;
      step?: string;
    }>();
    expectTypeOf<StatusData>().not.toBeAny();

    type TokensItem = Extract<MessageItem, { topic: "tokens"; kind: "data" }>;
    type TokensData = TokensItem["data"];

    expectTypeOf<TokensData>().toEqualTypeOf<{ token: string }>();
    expectTypeOf<TokensData>().not.toBeAny();
  });

  test("messages.delta and messages.all arrays have the same typed union", () => {
    type AllItem = Result["messages"]["all"][number];
    type DeltaItem = Result["messages"]["delta"][number];

    expectTypeOf<DeltaItem>().toEqualTypeOf<AllItem>();
  });

  test("messages.last is the same typed union or null", () => {
    type Last = Result["messages"]["last"];
    type AllItem = Result["messages"]["all"][number];

    expectTypeOf<Last>().toEqualTypeOf<AllItem | null>();
  });
});

// ---------------------------------------------------------------------------
// Subset of topics
// ---------------------------------------------------------------------------

describe("subscribing to a subset of topics", () => {
  type Result = UseRealtimeResult<ChatInstance, readonly ["status", "tokens"]>;

  test("messages.byTopic only exposes subscribed topics", () => {
    type ByTopicKeys = keyof Result["messages"]["byTopic"];
    expectTypeOf<ByTopicKeys>().toEqualTypeOf<"status" | "tokens">();
  });

  test("unsubscribed topics are not accessible on messages.byTopic", () => {
    //
    // @ts-expect-error - "artifact" is not in the subscribed topics
    type _ShouldFail = Result["messages"]["byTopic"]["artifact"];
  });

  test("messages.all union only contains subscribed topic variants", () => {
    type MessageItem = Result["messages"]["all"][number];

    type ArtifactItem = Extract<
      MessageItem,
      { topic: "artifact"; kind: "data" }
    >;
    expectTypeOf<ArtifactItem>().toBeNever();
  });
});

// ---------------------------------------------------------------------------
// Fallback: string channel (untyped)
// ---------------------------------------------------------------------------

describe("string channel fallback", () => {
  type Result = UseRealtimeResult<string, readonly ["foo", "bar"]>;

  test("messages.byTopic keys are still constrained to topic names", () => {
    type ByTopicKeys = keyof Result["messages"]["byTopic"];
    expectTypeOf<ByTopicKeys>().toEqualTypeOf<"foo" | "bar">();
  });

  test("messages.byTopic data falls back to Realtime.Message (untyped)", () => {
    type FooMessage = NonNullable<Result["messages"]["byTopic"]["foo"]>;

    expectTypeOf<FooMessage>().not.toBeNever();
    expectTypeOf<FooMessage["topic"]>().toBeString();
  });
});

// ---------------------------------------------------------------------------
// No `any` leaks
// ---------------------------------------------------------------------------

describe("no any leaks in typed channel results", () => {
  type Result = UseRealtimeResult<
    ChatInstance,
    readonly ["status", "tokens", "artifact", "usage"]
  >;

  test("connectionStatus is not any", () => {
    expectTypeOf<Result["connectionStatus"]>().not.toBeAny();
  });

  test("runStatus is not any", () => {
    expectTypeOf<Result["runStatus"]>().not.toBeAny();
  });

  test("messages.byTopic is not any", () => {
    expectTypeOf<Result["messages"]["byTopic"]>().not.toBeAny();
  });

  test("messages.byTopic.status is not any", () => {
    expectTypeOf<Result["messages"]["byTopic"]["status"]>().not.toBeAny();
  });

  test("messages.byTopic.status?.data is not any", () => {
    type StatusData = NonNullable<
      Result["messages"]["byTopic"]["status"]
    >["data"];
    expectTypeOf<StatusData>().not.toBeAny();
  });

  test("messages.byTopic.tokens?.data is not any", () => {
    type TokensData = NonNullable<
      Result["messages"]["byTopic"]["tokens"]
    >["data"];
    expectTypeOf<TokensData>().not.toBeAny();
  });

  test("messages.byTopic.artifact?.data is not any", () => {
    type ArtifactData = NonNullable<
      Result["messages"]["byTopic"]["artifact"]
    >["data"];
    expectTypeOf<ArtifactData>().not.toBeAny();
  });

  test("messages.byTopic.usage?.data is not any", () => {
    type UsageData = NonNullable<
      Result["messages"]["byTopic"]["usage"]
    >["data"];
    expectTypeOf<UsageData>().not.toBeAny();
  });

  test("messages.all items are not any", () => {
    type Item = Result["messages"]["all"][number];
    expectTypeOf<Item>().not.toBeAny();
  });

  test("messages.delta items are not any", () => {
    type Item = Result["messages"]["delta"][number];
    expectTypeOf<Item>().not.toBeAny();
  });

  test("messages.last is not any", () => {
    expectTypeOf<Result["messages"]["last"]>().not.toBeAny();
  });

  test("result is unknown, not any", () => {
    expectTypeOf<Result["result"]>().toBeUnknown();
  });

  test("error is Error | null, not any", () => {
    expectTypeOf<Result["error"]>().toEqualTypeOf<Error | null>();
  });

  test("reset is a function, not any", () => {
    expectTypeOf<Result["reset"]>().toBeFunction();
    expectTypeOf<Result["reset"]>().not.toBeAny();
  });
});
