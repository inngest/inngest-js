import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod/v3";
import { staticSchema } from "../triggers/triggers.ts";
import { channel } from "./channel.ts";
import type { Realtime } from "./types.ts";

describe("channel", () => {
  describe("static channels", () => {
    test("creates an instance with the given name", () => {
      const alerts = channel({
        name: "system:alerts",
        topics: {
          alert: { schema: z.object({ message: z.string() }) },
        },
      });

      expect(alerts.name).toBe("system:alerts");
    });

    test("exposes the topics config", () => {
      const schema = z.object({ message: z.string() });
      const alerts = channel({
        name: "system:alerts",
        topics: { alert: { schema } },
      });

      expect(alerts.topics.alert).toEqual({ schema });
    });

    test("creates topic accessors with correct channel and topic names", () => {
      const alerts = channel({
        name: "system:alerts",
        topics: {
          alert: { schema: z.object({ message: z.string() }) },
          info: { schema: z.object({ text: z.string() }) },
        },
      });

      expect(alerts.alert).toMatchObject({
        channel: "system:alerts",
        topic: "alert",
      });
      expect(alerts.info).toMatchObject({
        channel: "system:alerts",
        topic: "info",
      });
    });

    test("topic accessors carry the config reference", () => {
      const schema = z.object({ level: z.string() });
      const alerts = channel({
        name: "alerts",
        topics: { level: { schema } },
      });

      expect(alerts.level.config).toEqual({ schema });
    });

    test("exposes $infer for topic type extraction", () => {
      const ch = channel({
        name: "test",
        topics: {
          status: { schema: z.object({ message: z.string() }) },
        },
      });

      expect(ch.$infer).toBeDefined();
    });
  });

  describe("parameterized channels", () => {
    test("returns a callable definition", () => {
      const chat = channel({
        name: ({ threadId }: { threadId: string }) => `chat:${threadId}`,
        topics: {
          status: { schema: z.object({ message: z.string() }) },
        },
      });

      expect(typeof chat).toBe("function");
    });

    test("calling with params resolves the channel name", () => {
      const chat = channel({
        name: ({ threadId }: { threadId: string }) => `chat:${threadId}`,
        topics: {
          status: { schema: z.object({ message: z.string() }) },
        },
      });

      const instance = chat({ threadId: "abc123" });
      expect(instance.name).toBe("chat:abc123");
    });

    test("instance has topic accessors with resolved channel name", () => {
      const chat = channel({
        name: ({ threadId }: { threadId: string }) => `chat:${threadId}`,
        topics: {
          status: { schema: z.object({ message: z.string() }) },
          tokens: { schema: z.object({ token: z.string() }) },
        },
      });

      const instance = chat({ threadId: "t1" });

      expect(instance.status).toMatchObject({
        channel: "chat:t1",
        topic: "status",
      });
      expect(instance.tokens).toMatchObject({
        channel: "chat:t1",
        topic: "tokens",
      });
    });

    test("different params produce different channel names", () => {
      const chat = channel({
        name: ({ id }: { id: string }) => `run:${id}`,
        topics: { update: { schema: z.object({ v: z.number() }) } },
      });

      const a = chat({ id: "1" });
      const b = chat({ id: "2" });

      expect(a.name).toBe("run:1");
      expect(b.name).toBe("run:2");
      expect(a.update.channel).toBe("run:1");
      expect(b.update.channel).toBe("run:2");
    });

    test("exposes topics on the definition itself", () => {
      const schema = z.object({ message: z.string() });
      const chat = channel({
        name: ({ id }: { id: string }) => `chat:${id}`,
        topics: { status: { schema } },
      });

      expect(chat.topics.status).toEqual({ schema });
    });
  });

  describe("type-only topics via staticSchema<T>()", () => {
    test("creates a channel with staticSchema topics", () => {
      const ch = channel({
        name: "test",
        topics: {
          result: { schema: staticSchema<{ success: boolean }>() },
        },
      });

      expect(ch.name).toBe("test");
      expect(ch.result).toMatchObject({
        channel: "test",
        topic: "result",
      });
    });

    test("staticSchema topic config has a schema property", () => {
      const ch = channel({
        name: "test",
        topics: {
          result: { schema: staticSchema<{ success: boolean }>() },
        },
      });

      expect("schema" in ch.result.config).toBe(true);
    });
  });

  describe("mixed topics", () => {
    test("supports both zod and staticSchema topics on the same channel", () => {
      const ch = channel({
        name: "pipeline",
        topics: {
          status: { schema: z.object({ message: z.string() }) },
          usage: { schema: staticSchema<{ tokens: number }>() },
        },
      });

      expect(ch.status).toMatchObject({
        channel: "pipeline",
        topic: "status",
      });
      expect(ch.usage).toMatchObject({
        channel: "pipeline",
        topic: "usage",
      });
      expect("schema" in ch.status.config).toBe(true);
      expect("schema" in ch.usage.config).toBe(true);
    });
  });
});

describe("channel types", () => {
  describe("static channel type inference", () => {
    test("topic accessor is typed as TopicRef", () => {
      const ch = channel({
        name: "test",
        topics: {
          status: { schema: z.object({ message: z.string() }) },
        },
      });

      const ref: Realtime.TopicRef = ch.status;
      expect(ref.topic).toBe("status");
    });

    test("$infer extracts topic data types", () => {
      const ch = channel({
        name: "test",
        topics: {
          status: { schema: z.object({ message: z.string() }) },
        },
      });

      expectTypeOf(ch.$infer.status).toEqualTypeOf<{ message: string }>();
    });

    test("staticSchema topic $infer works", () => {
      const ch = channel({
        name: "test",
        topics: {
          result: { schema: staticSchema<{ success: boolean; output: unknown }>() },
        },
      });

      expectTypeOf(ch.$infer.result).toEqualTypeOf<{
        success: boolean;
        output: unknown;
      }>();
    });
  });

  describe("parameterized channel type inference", () => {
    test("$params infers the parameter type", () => {
      const chat = channel({
        name: ({ threadId }: { threadId: string }) => `chat:${threadId}`,
        topics: {
          status: { schema: z.object({ message: z.string() }) },
        },
      });

      expectTypeOf(chat.$params).toEqualTypeOf<{ threadId: string }>();
    });

    test("instance topic accessor is typed as TopicRef", () => {
      const chat = channel({
        name: ({ threadId }: { threadId: string }) => `chat:${threadId}`,
        topics: {
          status: { schema: z.object({ message: z.string() }) },
        },
      });

      const instance = chat({ threadId: "abc" });
      const ref: Realtime.TopicRef = instance.status;
      expect(ref.topic).toBe("status");
    });
  });

  describe("publish type safety", () => {
    test("TypedPublishFn accepts matching TopicRef and data", () => {
      const ch = channel({
        name: "test",
        topics: {
          status: { schema: z.object({ message: z.string() }) },
        },
      });

      //
      // This is a compile-time test: the function signature should accept
      // a TopicRef<{ message: string }> with matching data.
      //
      const publish: Realtime.TypedPublishFn = async () => {};
      expectTypeOf(publish).toBeCallableWith(ch.status, {
        message: "hello",
      });
    });

    test("TypedPublishFn rejects mismatched data", () => {
      const ch = channel({
        name: "test",
        topics: {
          status: { schema: z.object({ message: z.string() }) },
        },
      });

      const publish: Realtime.TypedPublishFn = async () => {};

      // @ts-expect-error - wrong data shape
      publish(ch.status, { wrong: 123 });
    });
  });
});

// ---------------------------------------------------------------------------
// InferTopicData type extraction
// ---------------------------------------------------------------------------

describe("InferTopicData", () => {
  test("extracts type from a zod schema topic", () => {
    type Config = { schema: z.ZodObject<{ message: z.ZodString }> };
    type Inferred = Realtime.InferTopicData<Config>;

    expectTypeOf<Inferred>().toEqualTypeOf<{ message: string }>();
  });

  test("extracts type from a staticSchema topic", () => {
    type Config = { schema: StandardSchemaV1<{ count: number }> };
    type Inferred = Realtime.InferTopicData<Config>;

    expectTypeOf<Inferred>().toEqualTypeOf<{ count: number }>();
  });

  test("inferred type is not any", () => {
    const config = { schema: z.object({ id: z.string() }) };
    type Inferred = Realtime.InferTopicData<typeof config>;

    expectTypeOf<Inferred>().not.toBeAny();
    expectTypeOf<Inferred>().toEqualTypeOf<{ id: string }>();
  });

  test("extracts types from a StandardSchemaV1 directly", () => {
    type Config = { schema: StandardSchemaV1<{ name: string }> };
    type Inferred = Realtime.InferTopicData<Config>;

    expectTypeOf<Inferred>().toEqualTypeOf<{ name: string }>();
  });

  test("extracts union types from staticSchema", () => {
    type Config = {
      schema: StandardSchemaV1<{ kind: "a"; value: string } | { kind: "b"; value: number }>;
    };
    type Inferred = Realtime.InferTopicData<Config>;

    expectTypeOf<Inferred>().toEqualTypeOf<
      { kind: "a"; value: string } | { kind: "b"; value: number }
    >();
  });
});

// ---------------------------------------------------------------------------
// TopicConfig shape validation
// ---------------------------------------------------------------------------

describe("TopicConfig", () => {
  test("accepts a zod schema", () => {
    const config: Realtime.TopicConfig = {
      schema: z.object({ message: z.string() }),
    };

    expect(config.schema).toBeDefined();
  });

  test("accepts a staticSchema", () => {
    const config: Realtime.TopicConfig = {
      schema: staticSchema<{ count: number }>(),
    };

    expect(config.schema).toBeDefined();
  });

  test("rejects missing schema", () => {
    // @ts-expect-error - schema is required
    const _config: Realtime.TopicConfig = {};
  });

  test("rejects non-schema values", () => {
    // @ts-expect-error - schema must be a StandardSchemaV1
    const _config: Realtime.TopicConfig = { schema: "not-a-schema" };
  });

  test("rejects arbitrary objects as schema", () => {
    // @ts-expect-error - must be StandardSchemaV1
    const _config: Realtime.TopicConfig = { schema: { foo: "bar" } };
  });
});

// ---------------------------------------------------------------------------
// Comprehensive channel type inference (multi-topic scenarios)
// ---------------------------------------------------------------------------

describe("multi-topic type inference", () => {
  const multiCh = channel({
    name: "pipeline",
    topics: {
      status: { schema: z.object({ message: z.string(), step: z.string().optional() }) },
      tokens: { schema: z.object({ token: z.string() }) },
      usage: { schema: staticSchema<{ inputTokens: number; outputTokens: number }>() },
    },
  });

  test("$infer extracts correct types for each topic", () => {
    expectTypeOf(multiCh.$infer.status).toEqualTypeOf<{
      message: string;
      step?: string;
    }>();

    expectTypeOf(multiCh.$infer.tokens).toEqualTypeOf<{ token: string }>();

    expectTypeOf(multiCh.$infer.usage).toEqualTypeOf<{
      inputTokens: number;
      outputTokens: number;
    }>();
  });

  test("each topic accessor carries the correct inferred type", () => {
    expectTypeOf(multiCh.status).toEqualTypeOf<
      Realtime.TopicRef<{ message: string; step?: string }>
    >();

    expectTypeOf(multiCh.tokens).toEqualTypeOf<
      Realtime.TopicRef<{ token: string }>
    >();

    expectTypeOf(multiCh.usage).toEqualTypeOf<
      Realtime.TopicRef<{ inputTokens: number; outputTokens: number }>
    >();
  });

  test("TypedPublishFn is type-safe per topic", () => {
    const publish: Realtime.TypedPublishFn = async () => {};

    expectTypeOf(publish).toBeCallableWith(multiCh.status, {
      message: "Working...",
    });

    expectTypeOf(publish).toBeCallableWith(multiCh.status, {
      message: "Working...",
      step: "step-1",
    });

    expectTypeOf(publish).toBeCallableWith(multiCh.tokens, {
      token: "abc",
    });

    expectTypeOf(publish).toBeCallableWith(multiCh.usage, {
      inputTokens: 100,
      outputTokens: 50,
    });

    // @ts-expect-error - status data passed to tokens topic
    publish(multiCh.tokens, { message: "wrong" });

    // @ts-expect-error - tokens data passed to usage topic
    publish(multiCh.usage, { token: "wrong" });

    // @ts-expect-error - extra property not in schema
    publish(multiCh.status, { message: "ok", extra: true });
  });
});

// ---------------------------------------------------------------------------
// Parameterized channel type safety
// ---------------------------------------------------------------------------

describe("parameterized channel type safety", () => {
  const agentChat = channel({
    name: ({ threadId }: { threadId: string }) => `agent-chat:${threadId}`,
    topics: {
      status: { schema: z.object({ message: z.string() }) },
      tokens: { schema: staticSchema<{ token: string; model?: string }>() },
    },
  });

  test("$params type is correct", () => {
    expectTypeOf(agentChat.$params).toEqualTypeOf<{ threadId: string }>();
  });

  test("definition $infer extracts correct types", () => {
    expectTypeOf(agentChat.$infer.status).toEqualTypeOf<{ message: string }>();
    expectTypeOf(agentChat.$infer.tokens).toEqualTypeOf<{
      token: string;
      model?: string;
    }>();
  });

  test("instance topic accessors have correct TopicRef types", () => {
    const instance = agentChat({ threadId: "t1" });

    expectTypeOf(instance.status).toEqualTypeOf<
      Realtime.TopicRef<{ message: string }>
    >();

    expectTypeOf(instance.tokens).toEqualTypeOf<
      Realtime.TopicRef<{ token: string; model?: string }>
    >();
  });

  test("TypedPublishFn works with parameterized channel instances", () => {
    const publish: Realtime.TypedPublishFn = async () => {};
    const instance = agentChat({ threadId: "t1" });

    expectTypeOf(publish).toBeCallableWith(instance.status, {
      message: "Thinking...",
    });

    expectTypeOf(publish).toBeCallableWith(instance.tokens, {
      token: "Hello",
    });

    expectTypeOf(publish).toBeCallableWith(instance.tokens, {
      token: "Hello",
      model: "gpt-4",
    });

    // @ts-expect-error - wrong data for topic
    publish(instance.status, { token: "wrong" });

    // @ts-expect-error - wrong data for topic
    publish(instance.tokens, { message: "wrong" });
  });

  test("definition exposes topics config for type-level inspection", () => {
    expectTypeOf(agentChat.topics).not.toBeAny();
    expectTypeOf(agentChat.topics.status).not.toBeAny();
    expectTypeOf(agentChat.topics.tokens).not.toBeAny();
  });
});

// ---------------------------------------------------------------------------
// TopicRef generic payload type
// ---------------------------------------------------------------------------

describe("TopicRef type narrowing", () => {
  test("TopicRef carries the inferred payload type", () => {
    const ch = channel({
      name: "test",
      topics: {
        data: { schema: z.object({ value: z.number() }) },
      },
    });

    type RefType = typeof ch.data;
    expectTypeOf<RefType>().toEqualTypeOf<Realtime.TopicRef<{ value: number }>>();
  });

  test("TopicRef for staticSchema carries the correct type", () => {
    const ch = channel({
      name: "test",
      topics: {
        result: { schema: staticSchema<{ ok: boolean; payload: string[] }>() },
      },
    });

    type RefType = typeof ch.result;
    expectTypeOf<RefType>().toEqualTypeOf<
      Realtime.TopicRef<{ ok: boolean; payload: string[] }>
    >();
  });

  test("different topics on the same channel have distinct TopicRef types", () => {
    const ch = channel({
      name: "test",
      topics: {
        a: { schema: z.object({ x: z.string() }) },
        b: { schema: staticSchema<{ y: number }>() },
      },
    });

    type RefA = typeof ch.a;
    type RefB = typeof ch.b;

    expectTypeOf<RefA>().toEqualTypeOf<Realtime.TopicRef<{ x: string }>>();
    expectTypeOf<RefB>().toEqualTypeOf<Realtime.TopicRef<{ y: number }>>();

    //
    // TopicRefs for different topics should not be assignable to each other
    // in a publish context. The publish function constrains TData via the
    // TopicRef generic, so passing the wrong ref+data pair is a type error.
    //
    const publish: Realtime.TypedPublishFn = async () => {};

    // @ts-expect-error - data for topic "a" doesn't match topic "b"
    publish(ch.b, { x: "wrong" });

    // @ts-expect-error - data for topic "b" doesn't match topic "a"
    publish(ch.a, { y: 123 });
  });
});

// ---------------------------------------------------------------------------
// getSubscriptionToken type inference (string-based)
// ---------------------------------------------------------------------------

describe("getSubscriptionToken types", () => {
  test("string-only token preserves channel and topic literal types", () => {
    type Token = Realtime.Subscribe.Token<
      Realtime.Channel<"my-channel">,
      ["status", "result"]
    >;

    expectTypeOf<Token["topics"]>().toEqualTypeOf<["status", "result"]>();
  });

  test("token with generic channel has string channel type", () => {
    type Token = Realtime.Subscribe.Token;

    expectTypeOf<Token["topics"]>().not.toBeAny();
  });
});

// ---------------------------------------------------------------------------
// ChannelInstance and ChannelDef structural types
// ---------------------------------------------------------------------------

describe("ChannelInstance structure", () => {
  test("static channel has name as literal type", () => {
    const ch = channel({
      name: "alerts",
      topics: {
        alert: { schema: z.object({ msg: z.string() }) },
      },
    });

    expectTypeOf(ch.name).toEqualTypeOf<"alerts">();
  });

  test("static channel name is the string value, not generic string", () => {
    const ch = channel({
      name: "specific-name",
      topics: {
        t: { schema: staticSchema<{ v: number }>() },
      },
    });

    expectTypeOf(ch.name).not.toEqualTypeOf<string>();
    expectTypeOf(ch.name).toEqualTypeOf<"specific-name">();
  });
});

describe("ChannelDef structure", () => {
  test("parameterized channel is callable", () => {
    const chat = channel({
      name: ({ id }: { id: string }) => `chat:${id}`,
      topics: {
        msg: { schema: z.object({ text: z.string() }) },
      },
    });

    expectTypeOf(chat).toBeCallableWith({ id: "abc" });
  });

  test("parameterized channel requires correct params", () => {
    const chat = channel({
      name: ({ id }: { id: string }) => `chat:${id}`,
      topics: {
        msg: { schema: z.object({ text: z.string() }) },
      },
    });

    //
    // Wrapped in a never-called function so @ts-expect-error lines
    // don't execute at runtime (they'd throw).
    //
    const _typeCheck = () => {
      // @ts-expect-error - wrong param name
      chat({ wrong: "abc" });

      // @ts-expect-error - missing params
      chat();

      // @ts-expect-error - wrong param type
      chat({ id: 123 });
    };
  });

  test("calling parameterized channel produces a ChannelInstance", () => {
    const chat = channel({
      name: ({ id }: { id: string }) => `chat:${id}`,
      topics: {
        msg: { schema: z.object({ text: z.string() }) },
      },
    });

    const instance = chat({ id: "abc" });

    expectTypeOf(instance.name).toBeString();
    expectTypeOf(instance.msg).toEqualTypeOf<Realtime.TopicRef<{ text: string }>>();
  });
});
