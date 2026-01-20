import { z } from "zod";
import { z as z_v3 } from "zod/v3";
import type { internalEvents } from "../helpers/consts.ts";
import type { IsAny, IsEqual } from "../helpers/types.ts";
import type { FailureEventPayload } from "../types.ts";
import { EventSchemas } from "./EventSchemas.ts";
import { type GetEvents, Inngest } from "./Inngest.ts";

// biome-ignore lint/suspicious/noExplicitAny: intentional
type Schemas<T extends EventSchemas<any>> = GetEvents<
  Inngest<{ id: "test"; schemas: T }>,
  true
>;

describe("EventSchemas", () => {
  test("adds internal types by default", () => {
    const schemas = new EventSchemas();

    type Expected =
      | `${internalEvents.FunctionFailed}`
      | `${internalEvents.FunctionFinished}`
      | `${internalEvents.FunctionInvoked}`
      | `${internalEvents.FunctionCancelled}`
      | `${internalEvents.ScheduledTimer}`;

    type Actual = Schemas<typeof schemas>[keyof Schemas<
      typeof schemas
    >]["name"];

    assertType<IsEqual<Expected, Actual>>(true);
  });

  test("providing no schemas keeps all types generic", () => {
    const inngest = new Inngest({
      id: "test",
      eventKey: "test-key-123",
    });

    inngest.createFunction({ id: "test" }, { event: "foo" }, ({ event }) => {
      assertType<string>(event.name);
      assertType<IsAny<typeof event.data>>(true);
    });
  });

  test("can use internal string literal types as triggers if any event schemas are defined", () => {
    const schemas = new EventSchemas();

    const inngest = new Inngest({
      id: "test",
      schemas,
      eventKey: "test-key-123",
    });

    inngest.createFunction(
      { id: "test" },
      { event: "inngest/function.failed" },
      ({ event }) => {
        assertType<
          | `${internalEvents.FunctionInvoked}`
          | `${internalEvents.FunctionFailed}`
        >(event.name);
        assertType<FailureEventPayload["data"]>(event.data);
      },
    );
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
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        "test.event": { data: any };
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
    });

    test("can set 'any' type for data alongside populated events", () => {
      const schemas = new EventSchemas().fromRecord<{
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        "test.event": { data: any };
        "test.event2": { data: { foo: string } };
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
      assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ foo: "" });
    });

    test("can set 'any' type for user", () => {
      const schemas = new EventSchemas().fromRecord<{
        // biome-ignore lint/suspicious/noExplicitAny: intentional
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
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        "test.event": { data: any; user: string };
      }>();
    });

    test("can set empty event", () => {
      const schemas = new EventSchemas().fromRecord<{
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

    test("can provide a type-narrowing-compatible wildcard", () => {
      const schemas = new EventSchemas().fromRecord<{
        "app/blog.post.*":
          | {
              name: "app/blog.post.created";
              data: { postId: string; createdAt: string };
            }
          | {
              name: "app/blog.post.published";
              data: { postId: string; publishedAt: string };
            };
      }>();

      assertType<
        IsEqual<
          Schemas<typeof schemas>["app/blog.post.*"]["name"],
          "app/blog.post.created" | "app/blog.post.published"
        >
      >(true);

      assertType<
        IsEqual<
          Schemas<typeof schemas>["app/blog.post.*"]["data"],
          | { postId: string; createdAt: string }
          | { postId: string; publishedAt: string }
        >
      >(true);

      // biome-ignore lint/suspicious/noExplicitAny: intentional
      const t0: Schemas<typeof schemas>["app/blog.post.*"] = null as any;
      const _fnToCheckTypesOnly = () => {
        if (t0.name === "app/blog.post.created") {
          assertType<string>(t0.data.createdAt);
          // @ts-expect-error - missing property
          t0.data.publishedAt;
        } else if (t0.name === "app/blog.post.published") {
          assertType<string>(t0.data.publishedAt);
          // @ts-expect-error - missing property
          t0.data.createdAt;
          // @ts-expect-error - name will not be the wildcard itself
        } else if (t0.name === "app/blog.post.*") {
          // This is an invalid name for a wildcard
        }
      };
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
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        data: any;
      }>();

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
    });

    test("can set 'any' type for user", () => {
      const schemas = new EventSchemas().fromUnion<{
        name: "test.event";
        data: { foo: string };
        // biome-ignore lint/suspicious/noExplicitAny: intentional
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
        // biome-ignore lint/suspicious/noExplicitAny: intentional
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

  describe("fromZod (v3)", () => {
    describe("record", () => {
      test("sets types based on input", () => {
        const schemas = new EventSchemas().fromZod({
          "test.event": {
            data: z_v3.object({ a: z_v3.string() }),
            user: z_v3.object({ b: z_v3.number() }),
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
              data: z_v3.object({ a: z_v3.string() }),
              user: z_v3.object({ b: z_v3.number() }),
            },
          })
          .fromZod({
            "test.event2": {
              data: z_v3.object({ c: z_v3.string() }),
              user: z_v3.object({ d: z_v3.number() }),
            },
          });

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
        assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });

        assertType<Schemas<typeof schemas>["test.event2"]["name"]>(
          "test.event2",
        );
        assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ c: "" });
        assertType<Schemas<typeof schemas>["test.event2"]["user"]>({ d: 0 });
      });

      test("can overwrite types with multiple calls", () => {
        const schemas = new EventSchemas()
          .fromZod({
            "test.event": {
              data: z_v3.object({ a: z_v3.string() }),
              user: z_v3.object({ b: z_v3.number() }),
            },
          })
          .fromZod({
            "test.event": {
              data: z_v3.object({ c: z_v3.string() }),
              user: z_v3.object({ d: z_v3.number() }),
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
            data: z_v3.any(),
          },
        });

        assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
      });

      test("can set 'any' type for user", () => {
        const schemas = new EventSchemas().fromZod({
          "test.event": {
            data: z_v3.any(),
            user: z_v3.any(),
          },
        });

        assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
      });

      test("cannot set non-object type for data", () => {
        new EventSchemas().fromZod({
          // @ts-expect-error - data must be object|any|unknown
          "test.event": { data: z_v3.string() },
        });
      });

      test("cannot set non-object type for user", () => {
        new EventSchemas().fromZod({
          // @ts-expect-error - user must be object|any|unknown
          "test.event": { data: z_v3.any(), user: z_v3.string() },
        });
      });

      test("fills in missing properties with default values", () => {
        const schemas = new EventSchemas().fromZod({
          "test.event": {
            data: z_v3.object({ a: z_v3.string() }),
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
            data: z_v3.discriminatedUnion("shared", [
              z_v3.object({
                shared: z_v3.literal("foo"),
                foo: z_v3.string(),
              }),
              z_v3.object({
                shared: z_v3.literal("bar"),
                bar: z_v3.number(),
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
            data: z_v3.union([
              z_v3.object({
                foo: z_v3.string(),
              }),
              z_v3.object({
                bar: z_v3.number(),
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
          "test.event": { data: z_v3.union([z_v3.string(), z_v3.number()]) },
        });
      });
    });

    describe("literal array", () => {
      test("sets types based on input", () => {
        const schemas = new EventSchemas().fromZod([
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.object({ a: z_v3.string() }),
            user: z_v3.object({ b: z_v3.number() }),
          }),
        ]);

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
        assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });
      });

      test("can concatenate types with multiple calls", () => {
        const schemas = new EventSchemas().fromZod([
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.object({ a: z_v3.string() }),
            user: z_v3.object({ b: z_v3.number() }),
          }),
          z_v3.object({
            name: z_v3.literal("test.event2"),
            data: z_v3.object({ c: z_v3.string() }),
            user: z_v3.object({ d: z_v3.number() }),
          }),
        ]);

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
        assertType<Schemas<typeof schemas>["test.event"]["user"]>({ b: 0 });

        assertType<Schemas<typeof schemas>["test.event2"]["name"]>(
          "test.event2",
        );
        assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ c: "" });
        assertType<Schemas<typeof schemas>["test.event2"]["user"]>({ d: 0 });
      });

      test("can overwrite types with multiple calls", () => {
        const schemas = new EventSchemas()
          .fromZod([
            z_v3.object({
              name: z_v3.literal("test.event"),
              data: z_v3.object({ a: z_v3.string() }),
              user: z_v3.object({ b: z_v3.number() }),
            }),
          ])
          .fromZod([
            z_v3.object({
              name: z_v3.literal("test.event"),
              data: z_v3.object({ c: z_v3.string() }),
              user: z_v3.object({ d: z_v3.number() }),
            }),
          ]);

        assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
        assertType<Schemas<typeof schemas>["test.event"]["data"]>({ c: "" });
        assertType<Schemas<typeof schemas>["test.event"]["user"]>({ d: 0 });
      });

      test.todo("cannot set extra properties");

      test("can set 'any' type for data", () => {
        const schemas = new EventSchemas().fromZod([
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.any(),
          }),
        ]);

        assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
      });

      test("can set 'any' type for user", () => {
        const schemas = new EventSchemas().fromZod([
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.any(),
            user: z_v3.any(),
          }),
        ]);

        assertType<IsAny<Schemas<typeof schemas>["test.event"]["user"]>>(true);
      });

      test("cannot set non-object type for data", () => {
        new EventSchemas().fromZod([
          // @ts-expect-error - data must be object|any|unknown
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.string(),
          }),
        ]);
      });

      test("cannot set non-object type for user", () => {
        new EventSchemas().fromZod([
          // @ts-expect-error - user must be object|any|unknown
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.any(),
            user: z_v3.string(),
          }),
        ]);
      });

      test("fills in missing properties with default values", () => {
        const schemas = new EventSchemas().fromZod([
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.object({ a: z_v3.string() }),
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
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.discriminatedUnion("shared", [
              z_v3.object({
                shared: z_v3.literal("foo"),
                foo: z_v3.string(),
              }),
              z_v3.object({
                shared: z_v3.literal("bar"),
                bar: z_v3.number(),
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
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.union([
              z_v3.object({
                foo: z_v3.string(),
              }),
              z_v3.object({
                bar: z_v3.number(),
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
          z_v3.object({
            name: z_v3.literal("test.event"),
            data: z_v3.union([z_v3.string(), z_v3.number()]),
          }),
        ]);
      });
    });
  });

  describe("fromSchema (including Zod v4)", () => {
    test("sets types based on input", () => {
      const schemas = new EventSchemas().fromSchema({
        "test.event": z.object({ a: z.string() }),
      });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(false);
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
    });

    test("can concatenate types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromSchema({
          "test.event": z.object({ a: z.string() }),
        })
        .fromSchema({
          "test.event2": z.object({ c: z.string() }),
        });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(false);
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });

      assertType<Schemas<typeof schemas>["test.event2"]["name"]>("test.event2");
      assertType<IsAny<Schemas<typeof schemas>["test.event2"]["data"]>>(false);
      assertType<Schemas<typeof schemas>["test.event2"]["data"]>({ c: "" });
    });

    test("can overwrite types with multiple calls", () => {
      const schemas = new EventSchemas()
        .fromSchema({
          "test.event": z.object({ a: z.string() }),
        })
        .fromSchema({
          "test.event": z.object({ c: z.string() }),
        });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(false);
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ c: "" });
    });

    test.todo("cannot set extra properties");

    test("can set 'any' type for data", () => {
      const schemas = new EventSchemas().fromSchema({
        "test.event": z.any(),
      });

      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(true);
    });

    test("cannot set non-object type for data", () => {
      new EventSchemas().fromSchema({
        // @ts-expect-error - data must be object|any|unknown
        "test.event": { data: z.string() },
      });
    });

    test("fills in missing properties with default values", () => {
      const schemas = new EventSchemas().fromSchema({
        "test.event": z.object({ a: z.string() }),
      });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(false);
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({ a: "" });
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["ts"], number | undefined>
      >(true);
      assertType<
        IsEqual<Schemas<typeof schemas>["test.event"]["v"], string | undefined>
      >(true);
    });

    test("can use a discriminated union", () => {
      const schemas = new EventSchemas().fromSchema({
        "test.event": z.discriminatedUnion("shared", [
          z.object({
            shared: z.literal("foo"),
            foo: z.string(),
          }),
          z.object({
            shared: z.literal("bar"),
            bar: z.number(),
          }),
        ]),
      });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(false);
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
      const schemas = new EventSchemas().fromSchema({
        "test.event": z.union([
          z.object({
            foo: z.string(),
          }),
          z.object({
            bar: z.number(),
          }),
        ]),
      });

      assertType<Schemas<typeof schemas>["test.event"]["name"]>("test.event");
      assertType<IsAny<Schemas<typeof schemas>["test.event"]["data"]>>(false);
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({
        foo: "",
      });
      assertType<Schemas<typeof schemas>["test.event"]["data"]>({
        bar: 0,
      });
    });

    test("cannot use a union with invalid values", () => {
      new EventSchemas().fromSchema({
        // @ts-expect-error - data must be object|any
        "test.event": { data: z.union([z.string(), z.number()]) },
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
            event.name,
          );
          assertType<{ a: string }>(event.data);
          assertType<IsAny<typeof event.user>>(true);
        },
      );
    });

    test("fetches 'any' event payload based on event", () => {
      const schemas = new EventSchemas().fromRecord<{
        // biome-ignore lint/suspicious/noExplicitAny: intentional
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
            event.name,
          );
          assertType<IsAny<typeof event.data>>(true);
          assertType<IsAny<typeof event.user>>(true);
        },
      );
    });
  });
});
