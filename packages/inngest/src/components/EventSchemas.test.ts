import { EventSchemas } from "@local/components/EventSchemas";
import { Inngest, type GetEvents } from "@local/components/Inngest";
import { type internalEvents } from "@local/helpers/consts";
import { type IsAny } from "@local/helpers/types";
import { type EventPayload } from "@local/types";
import { assertType, type IsEqual } from "type-plus";
import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schemas<T extends EventSchemas<any>> = GetEvents<
  Inngest<{ id: "test"; schemas: T }>,
  true
>;

describe("EventSchemas", () => {
  test("adds internal types by default", () => {
    const schemas = new EventSchemas();

    type Expected =
      | `${internalEvents.FunctionFailed}`
      | `${internalEvents.FunctionFinished}`;

    type Actual = Schemas<typeof schemas>[keyof Schemas<
      typeof schemas
    >]["name"];

    assertType<IsEqual<Expected, Actual>>(true);
  });

  describe("fromRecord", () => {
    test("sets types based on input", () => {
      const schemas = new EventSchemas().fromRecord<{
        "test.event": { data: { a: string }; user: { b: number } };
      }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });
    });

    test("can concatenate types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromRecord<{
          "test.event": { data: { a: string }; user: { b: number } };
        }>()
        .fromRecord<{
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
        .fromRecord<{
          "test.event": { data: { a: string }; user: { b: number } };
        }>()
        .fromRecord<{
          "test.event": { data: { c: string }; user: { d: number } };
        }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ c: "" });
      assertType<Schemas<typeof schemas>["test.event"]["user"]>({ d: 0 });
    });

    test.todo("cannot set extra properties");

    test("can set 'any' type for data", () => {
      const schemas = new EventSchemas().fromRecord<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: any };
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
    });

    test("can set 'any' type for data alongside populated events", () => {
      const schemas = new EventSchemas().fromRecord<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: any };
        "test.event2": { data: { foo: string } };
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
      assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ foo: "" });
    });

    test("can set 'any' type for user", () => {
      const schemas = new EventSchemas().fromRecord<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: { foo: string }; user: any };
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
    });

    test("cannot set non-object type for data", () => {
      // @ts-expect-error Data must be object type or any
      new EventSchemas().fromRecord<{
        "test.event": { data: string };
      }>();
    });

    test("can set event with matching 'name'", () => {
      const schemas = new EventSchemas().fromRecord<{
        "test.event": { name: "test.event"; data: { foo: string } };
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

    test("cannot set event with clashing 'name'", () => {
      // @ts-expect-error - name must match
      new EventSchemas().fromRecord<{
        "test.event": { name: "test.event2"; data: { foo: string } };
      }>();
    });

    test("cannot set event with clashing 'name' alongside valid event", () => {
      // @ts-expect-error - name must match
      new EventSchemas().fromRecord<{
        "test.event": { name: "test.event2"; data: { foo: string } };
        "test.event2": { name: "test.event2"; data: { foo: string } };
        "test.event3": { data: { foo: string } };
      }>();
    });

    test("cannot set non-object type for user", () => {
      // @ts-expect-error User must be object type or any
      new EventSchemas().fromRecord<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: any; user: string };
      }>();
    });

    test("can set empty event", () => {
      const schemas = new EventSchemas().fromRecord<{
        // eslint-disable-next-line @typescript-eslint/ban-types
        "test.event": {};
      }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["ts"], number | undefined>
      >(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["v"], string | undefined>
      >(true);
    });

    test("can set empty event alongside populated event", () => {
      const schemas = new EventSchemas().fromRecord<{
        // eslint-disable-next-line @typescript-eslint/ban-types
        "test.event": {};
        "test.event2": { data: { foo: string } };
      }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["ts"], number | undefined>
      >(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["v"], string | undefined>
      >(true);

      assertType<Schemas<typeof schemas>["test.event2"]["name"]>("test.event2");
      assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ foo: "" });
      assertType<IsAny<Schemas<typeof schemas>["test.event2"]["user"]>>(true);
      assertType<
        IsEqual<
          Schemas<typeof schemas>["test.event2"]["ts"],
          number | undefined
        >
      >(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event2"]["v"], string | undefined>
      >(true);
    });

    test("can set empty event with matching 'name'", () => {
      const schemas = new EventSchemas().fromRecord<{
        "test.event": { name: "test.event" };
      }>();

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["ts"], number | undefined>
      >(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["v"], string | undefined>
      >(true);
    });

    test("cannot set empty event with clashing 'name'", () => {
      // @ts-expect-error - name must match
      new EventSchemas().fromRecord<{
        "test.event": { name: "test.event2" };
      }>();
    });

    test("fills in missing properties with default values", () => {
      const schemas = new EventSchemas().fromRecord<{
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
    describe("record", () => {
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

        assertType<Schemas<typeof schemas>["test.event2"]["name"]>(
          "test.event2"
        );
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
          IsEqual<
            Schemas<typeof schemas>["test.event"]["ts"],
            number | undefined
          >
        >(true);
        assertType<
          IsEqual<
            Schemas<typeof schemas>["test.event"]["v"],
            string | undefined
          >
        >(true);
      });

      test("can use a discriminated union", () => {
        const schemas = new EventSchemas().fromZod({
          "test.event": {
            data: z.discriminatedUnion("shared", [
              z.object({
                shared: z.literal("foo"),
                foo: z.string(),
              }),
              z.object({
                shared: z.literal("bar"),
                bar: z.number(),
              }),
            ]),
          },
        });

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({
          shared: "foo" as const,
          foo: "",
        });
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({
          shared: "bar" as const,
          bar: 0,
        });
      });

      test("can use a union with valid values", () => {
        const schemas = new EventSchemas().fromZod({
          "test.event": {
            data: z.union([
              z.object({
                foo: z.string(),
              }),
              z.object({
                bar: z.number(),
              }),
            ]),
          },
        });

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({
          foo: "",
        });
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({
          bar: 0,
        });
      });

      test("cannot use a union with invalid values", () => {
        new EventSchemas().fromZod({
          // @ts-expect-error - data must be object|any
          "test.event": { data: z.union([z.string(), z.number()]) },
        });
      });
    });

    describe("literal array", () => {
      test("sets types based on input", () => {
        const schemas = new EventSchemas().fromZod([
          z.object({
            name: z.literal("test.event"),
            data: z.object({ a: z.string() }),
            user: z.object({ b: z.number() }),
          }),
        ]);

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
        assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });
      });

      test("can concatenate types with multiple calls", () => {
        const schemas = new EventSchemas().fromZod([
          z.object({
            name: z.literal("test.event"),
            data: z.object({ a: z.string() }),
            user: z.object({ b: z.number() }),
          }),
          z.object({
            name: z.literal("test.event2"),
            data: z.object({ c: z.string() }),
            user: z.object({ d: z.number() }),
          }),
        ]);

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
        assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });

        assertType<Schemas<typeof schemas>["test.event2"]["name"]>(
          "test.event2"
        );
        assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ c: "" });
        assertType<Schemas<typeof schemas>["test.event2"]["user"]>({ d: 0 });
      });

      test("can overwrite types with multiple calls", () => {
        const schemas = new EventSchemas()
          .fromZod([
            z.object({
              name: z.literal("test.event"),
              data: z.object({ a: z.string() }),
              user: z.object({ b: z.number() }),
            }),
          ])
          .fromZod([
            z.object({
              name: z.literal("test.event"),
              data: z.object({ c: z.string() }),
              user: z.object({ d: z.number() }),
            }),
          ]);

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({ c: "" });
        assertType<Schemas<typeof schemas>["test.event"]["user"]>({ d: 0 });
      });

      test.todo("cannot set extra properties");

      test("can set 'any' type for data", () => {
        const schemas = new EventSchemas().fromZod([
          z.object({
            name: z.literal("test.event"),
            data: z.any(),
          }),
        ]);

        assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
      });

      test("can set 'any' type for user", () => {
        const schemas = new EventSchemas().fromZod([
          z.object({
            name: z.literal("test.event"),
            data: z.any(),
            user: z.any(),
          }),
        ]);

        assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
      });

      test("cannot set non-object type for data", () => {
        new EventSchemas().fromZod([
          // @ts-expect-error - data must be object|any|unknown
          z.object({
            name: z.literal("test.event"),
            data: z.string(),
          }),
        ]);
      });

      test("cannot set non-object type for user", () => {
        new EventSchemas().fromZod([
          // @ts-expect-error - user must be object|any|unknown
          z.object({
            name: z.literal("test.event"),
            data: z.any(),
            user: z.string(),
          }),
        ]);
      });

      test("fills in missing properties with default values", () => {
        const schemas = new EventSchemas().fromZod([
          z.object({
            name: z.literal("test.event"),
            data: z.object({ a: z.string() }),
          }),
        ]);

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
        assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
        assertType<
          IsEqual<
            Schemas<typeof schemas>["test.event"]["ts"],
            number | undefined
          >
        >(true);
        assertType<
          IsEqual<
            Schemas<typeof schemas>["test.event"]["v"],
            string | undefined
          >
        >(true);
      });

      test("can use a discriminated union", () => {
        const schemas = new EventSchemas().fromZod([
          z.object({
            name: z.literal("test.event"),
            data: z.discriminatedUnion("shared", [
              z.object({
                shared: z.literal("foo"),
                foo: z.string(),
              }),
              z.object({
                shared: z.literal("bar"),
                bar: z.number(),
              }),
            ]),
          }),
        ]);

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({
          shared: "foo" as const,
          foo: "",
        });
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({
          shared: "bar" as const,
          bar: 0,
        });
      });

      test("can use a union with valid values", () => {
        const schemas = new EventSchemas().fromZod([
          z.object({
            name: z.literal("test.event"),
            data: z.union([
              z.object({
                foo: z.string(),
              }),
              z.object({
                bar: z.number(),
              }),
            ]),
          }),
        ]);

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({
          foo: "",
        });
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({
          bar: 0,
        });
      });

      test("cannot use a union with invalid values", () => {
        new EventSchemas().fromZod([
          // @ts-expect-error - data must be object|any
          z.object({
            name: z.literal("test.event"),
            data: z.union([z.string(), z.number()]),
          }),
        ]);
      });
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
      const schemas = new EventSchemas().fromRecord<{
        "test.event": { data: { a: string } };
      }>();

      const inngest = new Inngest({
        id: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        { id: "test" },
        { event: "test.event" },
        ({ event }) => {
          assertType<`${internalEvents.FunctionInvoked}` | "test.event">(
            event.name
          );
          assertType<{ a: string }>(event.data);
          assertType<IsAny<typeof event.user>>(true);
        }
      );
    });

    test("fetches 'any' event payload based on event", () => {
      const schemas = new EventSchemas().fromRecord<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: any };
      }>();

      const inngest = new Inngest({
        id: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        { id: "test" },
        { event: "test.event" },
        ({ event }) => {
          assertType<`${internalEvents.FunctionInvoked}` | "test.event">(
            event.name
          );
          assertType<IsAny<typeof event.data>>(true);
          assertType<IsAny<typeof event.user>>(true);
        }
      );
    });
  });

  describe("event matching expressions", () => {
    test("can match between two events with shared properties", () => {
      const schemas = new EventSchemas().fromRecord<{
        "test.event": { data: { foo: string } };
        "test.event2": { data: { foo: string } };
      }>();

      const inngest = new Inngest({
        id: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        {
          id: "test",
          cancelOn: [{ event: "test.event2", match: "data.foo" }],
        },
        { event: "test.event" },
        ({ step }) => {
          void step.waitForEvent("id", {
            event: "test.event2",
            match: "data.foo",
            timeout: "1h",
          });
        }
      );
    });

    test("cannot match between two events without shared properties", () => {
      const schemas = new EventSchemas().fromRecord<{
        "test.event": { data: { foo: string } };
        "test.event2": { data: { bar: boolean } };
      }>();

      const inngest = new Inngest({
        id: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        {
          id: "test",
          // @ts-expect-error - `"data.foo"` is not assignable
          cancelOn: [{ event: "test.event2", match: "data.foo" }],
        },
        { event: "test.event" },
        ({ step }) => {
          void step.waitForEvent("id", {
            event: "test.event2",
            // @ts-expect-error - `"data.foo"` is not assignable
            match: "data.foo",
            timeout: "1h",
          });
        }
      );
    });

    test("can match any property on typed event A when B is 'any'", () => {
      const schemas = new EventSchemas().fromRecord<{
        "test.event": { data: { foo: string } };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event2": { data: any };
      }>();

      const inngest = new Inngest({
        id: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        {
          id: "test",
          cancelOn: [{ event: "test.event2", match: "data.foo" }],
        },
        { event: "test.event" },
        ({ step }) => {
          void step.waitForEvent("id", {
            event: "test.event2",
            match: "data.foo",
            timeout: "1h",
          });
        }
      );
    });

    test("can match any property on typed event B when A is 'any'", () => {
      const schemas = new EventSchemas().fromRecord<{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "test.event": { data: any };
        "test.event2": { data: { foo: string } };
      }>();

      const inngest = new Inngest({
        id: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        {
          id: "test",
          cancelOn: [{ event: "test.event2", match: "data.foo" }],
        },
        { event: "test.event" },
        ({ step }) => {
          void step.waitForEvent("id", {
            event: "test.event",
            match: "data.foo",
            timeout: "1h",
          });
        }
      );
    });

    test("does not infinitely recurse when matching events with recursive types", () => {
      type JsonObject = { [Key in string]?: JsonValue };
      type JsonArray = Array<JsonValue>;
      type JsonValue =
        | string
        | number
        | boolean
        | JsonObject
        | JsonArray
        | null;

      interface TestEvent extends EventPayload {
        name: "test.event";
        data: { id: string; other: JsonValue; yer: string[] };
      }

      interface TestEvent2 extends EventPayload {
        name: "test.event2";
        data: { id: string; somethingElse: JsonValue };
      }

      const schemas = new EventSchemas().fromUnion<TestEvent | TestEvent2>();

      const inngest = new Inngest({
        id: "test",
        schemas,
        eventKey: "test-key-123",
      });

      inngest.createFunction(
        { id: "test", cancelOn: [{ event: "test.event2", match: "data.id" }] },
        { event: "test.event" },
        ({ step }) => {
          void step.waitForEvent("id", {
            event: "test.event2",
            match: "data.id",
            timeout: "1h",
          });
        }
      );
    });
  });
});
