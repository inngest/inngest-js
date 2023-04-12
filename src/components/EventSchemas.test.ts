import { IsEqual, assertType } from "type-plus";
import { z } from "zod";
import { IsAny } from "../helpers/types";
import { EventPayload, GetEvents } from "../types";
import { EventSchemas } from "./EventSchemas";
import { Inngest } from "./Inngest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schemas<T extends EventSchemas<any>> = GetEvents<
  Inngest<{ name: "test"; schemas: T }>
>;

describe("EventSchemas", () => {
  test("creates generic types by default", () => {
    const schemas = new EventSchemas();

    assertType<IsEqual<Schemas<typeof schemas>, Record<string, EventPayload>>>(
      true
    );
  });

  describe("fromTypes", () => {
    test("sets types based on input", () => {
      const schemas = new EventSchemas().fromTypes<{
        "test.event": { data: { a: string }; user: { b: number } };
      }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });
    });

    test("can concatenate types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromTypes<{
          "test.event": { data: { a: string }; user: { b: number } };
        }>()
        .fromTypes<{
          "test.event2": { data: { c: string }; user: { d: number } };
        }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });

      assertType<Schemas<typeof schemas>["test.event2"]["name"]>("test.event2");
      assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ c: "" });
      assertType<Schemas<typeof schemas>["test.event2"]["user"]>({ d: 0 });
    });

    test("can overwrite types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromTypes<{
          "test.event": { data: { a: string }; user: { b: number } };
        }>()
        .fromTypes<{
          "test.event": { data: { c: string }; user: { d: number } };
        }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ c: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ d: 0 });
    });

    test.todo("cannot set extra properties");

    test("can set 'any' type for data", () => {
      const schemas = new EventSchemas().fromTypes<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: any };
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
    });

    test("can set 'any' type for user", () => {
      const schemas = new EventSchemas().fromTypes<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: { foo: string }; user: any };
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
    });

    test("cannot set non-object type for data", () => {
      // @ts-expect-error Data must be object type or any
      new EventSchemas().fromTypes<{
        "test.event": { data: string };
      }>();
    });

    test("cannot set non-object type for user", () => {
      // @ts-expect-error User must be object type or any
      new EventSchemas().fromTypes<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: any; user: string };
      }>();
    });

    test("fills in missing properties with default values", () => {
      const schemas = new EventSchemas().fromTypes<{
        "test.event": { data: { foo: string } };
      }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ foo: "" });
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["ts"], number | undefined>
      >(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["v"], string | undefined>
      >(true);
    });
  });

  describe("fromUnion", () => {
    type TestEvent = {
      name: "test.event";
      data: { a: string };
      user: { b: number };
    };

    type TestEvent2 = {
      name: "test.event2";
      data: { c: string };
      user: { d: number };
    };

    test("sets types based on input", () => {
      const schemas = new EventSchemas().fromUnion<TestEvent>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });
    });

    test("can concatenate types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromUnion<TestEvent>()
        .fromUnion<TestEvent2>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });

      assertType<Schemas<typeof schemas>["test.event2"]["name"]>("test.event2");
      assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ c: "" });
      assertType<Schemas<typeof schemas>["test.event2"]["user"]>({ d: 0 });
    });

    test("can overwrite types with multiple calls", () => {
      const schemas = new EventSchemas().fromUnion<TestEvent>().fromUnion<{
        name: "test.event";
        data: { c: string };
        user: { d: number };
      }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ c: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ d: 0 });
    });

    test.todo("cannot set extra properties");

    test("can set 'any' type for data", () => {
      const schemas = new EventSchemas().fromUnion<{
        name: "test.event";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: any;
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
    });

    test("can set 'any' type for user", () => {
      const schemas = new EventSchemas().fromUnion<{
        name: "test.event";
        data: { foo: string };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        user: any;
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
    });

    test("cannot set non-object type for data", () => {
      // @ts-expect-error Data must be object type or any
      new EventSchemas().fromUnion<{ name: "test.event"; data: string }>();
    });

    test("cannot set non-object type for user", () => {
      // @ts-expect-error User must be object type or any
      new EventSchemas().fromUnion<{
        name: "test.event";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: any;
        user: string;
      }>();
    });

    test("fills in missing properties with default values", () => {
      const schemas = new EventSchemas().fromUnion<{
        name: "test.event";
        data: { foo: string };
      }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ foo: "" });
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["ts"], number | undefined>
      >(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["v"], string | undefined>
      >(true);
    });
  });

  describe("fromZod", () => {
    test("sets types based on input", () => {
      const schemas = new EventSchemas().fromZod({
        "test.event": {
          data: z.object({ a: z.string() }),
          user: z.object({ b: z.number() }),
        },
      });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });
    });

    test("can concatenate types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromZod({
          "test.event": {
            data: z.object({ a: z.string() }),
            user: z.object({ b: z.number() }),
          },
        })
        .fromZod({
          "test.event2": {
            data: z.object({ c: z.string() }),
            user: z.object({ d: z.number() }),
          },
        });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });

      assertType<Schemas<typeof schemas>["test.event2"]["name"]>("test.event2");
      assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ c: "" });
      assertType<Schemas<typeof schemas>["test.event2"]["user"]>({ d: 0 });
    });

    test("can overwrite types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromZod({
          "test.event": {
            data: z.object({ a: z.string() }),
            user: z.object({ b: z.number() }),
          },
        })
        .fromZod({
          "test.event": {
            data: z.object({ c: z.string() }),
            user: z.object({ d: z.number() }),
          },
        });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ c: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ d: 0 });
    });

    test.todo("cannot set extra properties");

    test("can set 'any' type for data", () => {
      const schemas = new EventSchemas().fromZod({
        "test.event": {
          data: z.any(),
        },
      });

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
    });

    test("can set 'any' type for user", () => {
      const schemas = new EventSchemas().fromZod({
        "test.event": {
          data: z.any(),
          user: z.any(),
        },
      });

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
    });

    test("cannot set non-object type for data", () => {
      new EventSchemas().fromZod({
        // @ts-expect-error - data must be object|any|unknown
        "test.event": { data: z.string() },
      });
    });

    test("cannot set non-object type for user", () => {
      new EventSchemas().fromZod({
        // @ts-expect-error - user must be object|any|unknown
        "test.event": { data: z.any(), user: z.string() },
      });
    });

    test("fills in missing properties with default values", () => {
      const schemas = new EventSchemas().fromZod({
        "test.event": {
          data: z.object({ a: z.string() }),
        },
      });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["ts"], number | undefined>
      >(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["v"], string | undefined>
      >(true);
    });
  });

  describe("fromGenerated", () => {
    test("sets types based on input", () => {
      const schemas = new EventSchemas().fromGenerated<{
        "test.event": {
          name: "test.event";
          data: { a: string };
          user: { b: number };
        };
      }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });
    });

    test("can concatenate types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromGenerated<{
          "test.event": {
            name: "test.event";
            data: { a: string };
            user: { b: number };
          };
        }>()
        .fromGenerated<{
          "test.event2": {
            name: "test.event2";
            data: { c: string };
            user: { d: number };
          };
        }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });

      assertType<Schemas<typeof schemas>["test.event2"]["name"]>("test.event2");
      assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ c: "" });
      assertType<Schemas<typeof schemas>["test.event2"]["user"]>({ d: 0 });
    });

    test("can overwrite types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromGenerated<{
          "test.event": {
            name: "test.event";
            data: { a: string };
            user: { b: number };
          };
        }>()
        .fromGenerated<{
          "test.event": {
            name: "test.event";
            data: { c: string };
            user: { d: number };
          };
        }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ c: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ d: 0 });
    });
  });

  describe("event payloads", () => {
    test("fetches event payload based on event", () => {
      const schemas = new EventSchemas().fromTypes<{
        "test.event": { data: { a: string } };
      }>();

      const inngest = new Inngest({
        name: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        { name: "test" },
        { event: "test.event" },
        ({ event }) => {
          assertType<"test.event">(event.name);
          assertType<{ a: string }>(event.data);
          assertType<IsAny<typeof event.user>>(true);
        }
      );
    });

    test("fetches 'any' event payload based on event", () => {
      const schemas = new EventSchemas().fromTypes<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: any };
      }>();

      const inngest = new Inngest({
        name: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        { name: "test" },
        { event: "test.event" },
        ({ event }) => {
          assertType<"test.event">(event.name);
          assertType<IsAny<typeof event.data>>(true);
          assertType<IsAny<typeof event.user>>(true);
        }
      );
    });
  });

  describe("event matching expressions", () => {
    test("can match between two events with shared properties", () => {
      const schemas = new EventSchemas().fromTypes<{
        "test.event": { data: { foo: string } };
        "test.event2": { data: { foo: string } };
      }>();

      const inngest = new Inngest({
        name: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        {
          name: "test",
          cancelOn: [{ event: "test.event2", match: "data.foo" }],
        },
        { event: "test.event" },
        ({ step }) => {
          void step.waitForEvent("test.event2", {
            match: "data.foo",
            timeout: "1h",
          });
        }
      );
    });

    test("can match any property on typed event A when B is 'any'", () => {
      const schemas = new EventSchemas().fromTypes<{
        "test.event": { data: { foo: string } };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event2": { data: any };
      }>();

      const inngest = new Inngest({
        name: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        {
          name: "test",
          cancelOn: [{ event: "test.event2", match: "data.foo" }],
        },
        { event: "test.event" },
        ({ step }) => {
          void step.waitForEvent("test.event2", {
            match: "data.foo",
            timeout: "1h",
          });
        }
      );
    });

    test("can match any property on typed event B when A is 'any'", () => {
      const schemas = new EventSchemas().fromTypes<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: any };
        "test.event2": { data: { foo: string } };
      }>();

      const inngest = new Inngest({
        name: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        {
          name: "test",
          cancelOn: [{ event: "test.event2", match: "data.foo" }],
        },
        { event: "test.event" },
        ({ step }) => {
          void step.waitForEvent("test.event2", {
            match: "data.foo",
            timeout: "1h",
          });
        }
      );
    });
  });
});
