import { z } from "zod/v3";
import { TopicDefinitionImpl, topic } from "./topic.ts";

describe("topic", () => {
  test("creates a TopicDefinitionImpl with the given name", () => {
    const t = topic("status");
    expect(t).toBeInstanceOf(TopicDefinitionImpl);
    expect(t.name).toBe("status");
  });

  test("has no schema by default", () => {
    const t = topic("status");
    expect(t.getSchema()).toBeUndefined();
  });
});

describe("TopicDefinitionImpl", () => {
  describe("type()", () => {
    test("returns the same instance (zero runtime cost)", () => {
      const t = new TopicDefinitionImpl("events");
      const typed = t.type<{ userId: string }>();

      //
      // type() doesn't create a new instance — it just narrows the TS type
      //
      expect(typed).toBe(t);
    });

    test("preserves the topic name", () => {
      const t = new TopicDefinitionImpl("events");
      const typed = t.type<{ userId: string }>();
      expect(typed.name).toBe("events");
    });

    test("does not set a schema", () => {
      const t = new TopicDefinitionImpl("events");
      const typed = t.type<{ userId: string }>();
      expect(typed.getSchema()).toBeUndefined();
    });
  });

  describe("schema()", () => {
    test("returns a new instance with the schema attached", () => {
      const schema = z.object({ message: z.string() });
      const t = new TopicDefinitionImpl("status");
      const withSchema = t.schema(schema);

      expect(withSchema).not.toBe(t);
      expect(withSchema.getSchema()).toBe(schema);
    });

    test("preserves the topic name", () => {
      const schema = z.object({ message: z.string() });
      const t = new TopicDefinitionImpl("status");
      const withSchema = t.schema(schema);

      expect(withSchema.name).toBe("status");
    });

    test("original instance remains schema-free", () => {
      const schema = z.object({ message: z.string() });
      const t = new TopicDefinitionImpl("status");
      t.schema(schema);

      expect(t.getSchema()).toBeUndefined();
    });
  });

  describe("constructor with schema", () => {
    test("accepts schema in constructor", () => {
      const schema = z.object({ level: z.string() });
      const t = new TopicDefinitionImpl("alerts", schema);

      expect(t.name).toBe("alerts");
      expect(t.getSchema()).toBe(schema);
    });
  });
});
