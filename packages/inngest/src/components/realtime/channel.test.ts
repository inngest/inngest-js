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
