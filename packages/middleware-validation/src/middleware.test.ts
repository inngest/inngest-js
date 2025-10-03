import { InngestTestEngine } from "@inngest/test";
import FetchMock from "fetch-mock-jest";
import { EventSchemas, Inngest, type Logger } from "inngest";
import { z } from "zod";
import { validationMiddleware } from "./middleware";

const baseUrl = "https://unreachable.com";
const eventKey = "123";
const fetchMock = FetchMock.sandbox();

describe("validationMiddleware", () => {
  test("should allow an event through with no schema", async () => {
    const inngest = new Inngest({
      id: "test",
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [{ name: "test" }],
    });

    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual("success");
  });

  test("should allow an event through with a non-Zod schema", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromRecord<{
        test: {
          data: {
            message: string;
          };
        };
      }>(),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [{ name: "test" }],
    });

    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual("success");
  });

  test("should validate a correct event with a Zod schema (fromZod)", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromZod({
        test: {
          data: z.object({
            message: z.string(),
          }),
        },
      }),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [{ name: "test", data: { message: "hello" } }],
    });

    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual("success");
  });

  test("should validate a correct event with a Zod schema (fromSchema)", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromSchema({
        test: z.object({
          message: z.string(),
        }),
      }),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [{ name: "test", data: { message: "hello" } }],
    });

    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual("success");
  });

  test("should not allow an event through with an incorrect Zod schema (fromZod)", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromZod({
        test: {
          data: z.object({
            message: z.string(),
          }),
        },
      }),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [{ name: "test", data: { message: 123 } }],
    });

    const { result, error } = await t.execute();

    expect(JSON.stringify(error)).toContain("failed validation");
    expect(result).toBeUndefined();
  });

  test("should not allow an event through with an incorrect Zod schema (fromSchema)", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromSchema({
        test: z.object({
          message: z.string(),
        }),
      }),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [{ name: "test", data: { message: 123 } }],
    });

    const { result, error } = await t.execute();

    expect(JSON.stringify(error)).toContain("failed validation");
    expect(result).toBeUndefined();
  });

  describe("inngest/function.invoked", () => {
    test("should test against multiple schemas for `inngest/function.invoked` (fromZod)", async () => {
      const inngest = new Inngest({
        id: "test",
        schemas: new EventSchemas().fromZod({
          a: {
            data: z.object({
              a: z.boolean(),
            }),
          },
          b: {
            data: z.object({
              b: z.boolean(),
            }),
          },
        }),
        middleware: [validationMiddleware()],
      });

      const t = new InngestTestEngine({
        function: inngest.createFunction(
          { id: "test" },
          { event: "b" },
          () => "success",
        ),
        events: [{ name: "inngest/function.invoked", data: { b: true } }],
      });

      const { result, error } = await t.execute();

      expect(error).toBeUndefined();
      expect(result).toEqual("success");
    });

    test("should test against multiple schemas for `inngest/function.invoked` (fromSchema)", async () => {
      const inngest = new Inngest({
        id: "test",
        schemas: new EventSchemas().fromSchema({
          a: z.object({
            a: z.boolean(),
          }),
          b: z.object({
            b: z.boolean(),
          }),
        }),
        middleware: [validationMiddleware()],
      });

      const t = new InngestTestEngine({
        function: inngest.createFunction(
          { id: "test" },
          { event: "b" },
          () => "success",
        ),
        events: [{ name: "inngest/function.invoked", data: { b: true } }],
      });

      const { result, error } = await t.execute();

      expect(error).toBeUndefined();
      expect(result).toEqual("success");
    });
  });

  describe("disallowSchemalessEvents", () => {
    test("should fail if an event has no schema", async () => {
      const inngest = new Inngest({
        id: "test",
        middleware: [validationMiddleware({ disallowSchemalessEvents: true })],
      });

      const t = new InngestTestEngine({
        function: inngest.createFunction(
          { id: "test" },
          { event: "test" },
          () => "success",
        ),
        events: [{ name: "test" }],
      });

      const { result, error } = await t.execute();

      expect(JSON.stringify(error)).toContain("has no schema defined");
      expect(result).toBeUndefined();
    });

    test("should fail if an event has a type-only schema", async () => {
      const inngest = new Inngest({
        id: "test",
        schemas: new EventSchemas().fromRecord<{
          test: {
            data: {
              message: string;
            };
          };
        }>(),
        middleware: [validationMiddleware({ disallowSchemalessEvents: true })],
      });

      const t = new InngestTestEngine({
        function: inngest.createFunction(
          { id: "test" },
          { event: "test" },
          () => "success",
        ),
        events: [{ name: "test" }],
      });

      const { result, error } = await t.execute();

      expect(JSON.stringify(error)).toContain("has no schema defined");
      expect(result).toBeUndefined();
    });

    test("should succeed if an event has a schema (fromZod)", async () => {
      const inngest = new Inngest({
        id: "test",
        schemas: new EventSchemas().fromZod({
          test: {
            data: z.object({
              message: z.string(),
            }),
          },
        }),
        middleware: [validationMiddleware({ disallowSchemalessEvents: true })],
      });

      const t = new InngestTestEngine({
        function: inngest.createFunction(
          { id: "test" },
          { event: "test" },
          () => "success",
        ),
        events: [{ name: "test", data: { message: "hello" } }],
      });

      const { result, error } = await t.execute();

      expect(error).toBeUndefined();
      expect(result).toEqual("success");
    });

    test("should succeed if an event has a schema (fromSchema)", async () => {
      const inngest = new Inngest({
        id: "test",
        schemas: new EventSchemas().fromSchema({
          test: z.object({
            message: z.string(),
          }),
        }),
        middleware: [validationMiddleware({ disallowSchemalessEvents: true })],
      });

      const t = new InngestTestEngine({
        function: inngest.createFunction(
          { id: "test" },
          { event: "test" },
          () => "success",
        ),
        events: [{ name: "test", data: { message: "hello" } }],
      });

      const { result, error } = await t.execute();

      expect(error).toBeUndefined();
      expect(result).toEqual("success");
    });

    test("should succeed if an `inngest/function.invoked` event has a schema (fromZod)", async () => {
      const inngest = new Inngest({
        id: "test",
        schemas: new EventSchemas().fromZod({
          test: {
            data: z.object({
              message: z.string(),
            }),
          },
        }),
        middleware: [validationMiddleware({ disallowSchemalessEvents: true })],
      });

      const t = new InngestTestEngine({
        function: inngest.createFunction(
          { id: "test" },
          { event: "test" },
          () => "success",
        ),
        events: [
          { name: "inngest/function.invoked", data: { message: "hello" } },
        ],
      });

      const { result, error } = await t.execute();

      expect(error).toBeUndefined();
      expect(result).toEqual("success");
    });

    test("should succeed if an `inngest/function.invoked` event has a schema (fromSchema)", async () => {
      const inngest = new Inngest({
        id: "test",
        schemas: new EventSchemas().fromSchema({
          test: z.object({
            message: z.string(),
          }),
        }),
        middleware: [validationMiddleware({ disallowSchemalessEvents: true })],
      });

      const t = new InngestTestEngine({
        function: inngest.createFunction(
          { id: "test" },
          { event: "test" },
          () => "success",
        ),
        events: [
          { name: "inngest/function.invoked", data: { message: "hello" } },
        ],
      });

      const { result, error } = await t.execute();

      expect(error).toBeUndefined();
      expect(result).toEqual("success");
    });
  });

  test("handles a literal Zod schema (fromZod)", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromZod([
        z.object({
          name: z.literal("test"),
          data: z.object({
            message: z.string(),
          }),
        }),
      ]),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [{ name: "test", data: { message: "hello" } }],
    });

    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual("success");
  });

  test("handles a nested Zod schema (fromZod)", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromZod({
        test: {
          data: z.object({
            message: z.object({
              content: z.string(),
            }),
          }),
        },
      }),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [{ name: "test", data: { message: { content: "hello" } } }],
    });

    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual("success");
  });

  test("handles a Zod schema (fromSchema)", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromSchema({
        test: z.object({
          message: z.object({
            content: z.string(),
          }),
        }),
      }),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [{ name: "test", data: { message: { content: "hello" } } }],
    });

    const { result, error } = await t.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual("success");
  });

  test("validates all events in a batch (fromZod)", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromZod({
        test: {
          data: z.object({
            message: z.string(),
          }),
        },
      }),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [
        { name: "test", data: { message: "hello" } },
        { name: "test", data: { message: 123 } },
      ],
    });

    const { result, error } = await t.execute();

    expect(JSON.stringify(error)).toContain("failed validation");
    expect(result).toBeUndefined();
  });

  test("validates all events in a batch (fromSchema)", async () => {
    const inngest = new Inngest({
      id: "test",
      schemas: new EventSchemas().fromSchema({
        test: z.object({
          message: z.string(),
        }),
      }),
      middleware: [validationMiddleware()],
    });

    const t = new InngestTestEngine({
      function: inngest.createFunction(
        { id: "test" },
        { event: "test" },
        () => "success",
      ),
      events: [
        { name: "test", data: { message: "hello" } },
        { name: "test", data: { message: 123 } },
      ],
    });

    const { result, error } = await t.execute();

    expect(JSON.stringify(error)).toContain("failed validation");
    expect(result).toBeUndefined();
  });

  describe("onSendEvent", () => {
    describe("inngest.send()", () => {
      afterEach(() => {
        fetchMock.mockReset();
      });

      test("should validate an event before sending it (fromZod)", async () => {
        const inngest = new Inngest({
          id: "test",
          schemas: new EventSchemas().fromZod({
            test: {
              data: z.object({
                message: z.string(),
              }),
            },
          }),
          middleware: [validationMiddleware()],
        });

        const t = new InngestTestEngine({
          function: inngest.createFunction(
            { id: "test" },
            { event: "test" },
            () =>
              inngest.send({
                name: "test",
                data: { message: 123 as unknown as string },
              }),
          ),
          events: [{ name: "test", data: { message: "hello" } }],
        });

        const { result, error } = await t.execute();

        expect(JSON.stringify(error)).toContain("failed validation");
        expect(result).toBeUndefined();
      });

      test("should validate an event before sending it (fromSchema)", async () => {
        const inngest = new Inngest({
          id: "test",
          schemas: new EventSchemas().fromSchema({
            test: z.object({
              message: z.string(),
            }),
          }),
          middleware: [validationMiddleware()],
        });

        const t = new InngestTestEngine({
          function: inngest.createFunction(
            { id: "test" },
            { event: "test" },
            () =>
              inngest.send({
                name: "test",
                data: { message: 123 as unknown as string },
              }),
          ),
          events: [{ name: "test", data: { message: "hello" } }],
        });

        const { result, error } = await t.execute();

        expect(JSON.stringify(error)).toContain("failed validation");
        expect(result).toBeUndefined();
      });

      test("should not validate an event before sending it if disabled (fromZod)", async () => {
        fetchMock.postOnce(`${baseUrl}/e/${eventKey}`, {
          status: 200,
          ids: ["123"],
        });

        const inngest = new Inngest({
          id: "test",
          fetch: fetchMock as typeof fetch,
          baseUrl,
          eventKey,
          schemas: new EventSchemas().fromZod({
            test: {
              data: z.object({
                message: z.string(),
              }),
            },
          }),
          middleware: [
            validationMiddleware({ disableOutgoingValidation: true }),
          ],
        });

        await expect(
          inngest.send({
            name: "test",
            data: { message: 123 as unknown as string },
          }),
        ).resolves.not.toThrow();
      });

      test("should not validate an event before sending it if disabled (fromSchema)", async () => {
        fetchMock.postOnce(`${baseUrl}/e/${eventKey}`, {
          status: 200,
          ids: ["123"],
        });

        const inngest = new Inngest({
          id: "test",
          fetch: fetchMock as typeof fetch,
          baseUrl,
          eventKey,
          schemas: new EventSchemas().fromSchema({
            test: z.object({
              message: z.string(),
            }),
          }),
          middleware: [
            validationMiddleware({ disableOutgoingValidation: true }),
          ],
        });

        await expect(
          inngest.send({
            name: "test",
            data: { message: 123 as unknown as string },
          }),
        ).resolves.not.toThrow();
      });
    });

    describe("step.sendEvent()", () => {
      afterEach(() => {
        fetchMock.mockReset();
      });

      test("should validate an event before sending it (fromZod)", async () => {
        const inngest = new Inngest({
          id: "test",
          schemas: new EventSchemas().fromZod({
            test: {
              data: z.object({
                message: z.string(),
              }),
            },
          }),
          middleware: [validationMiddleware()],
          logger: { error: () => undefined } as Logger,
        });

        const fn = inngest.createFunction(
          { id: "test" },
          { event: "test" },
          async ({ step }) => {
            await step.sendEvent("id", {
              name: "test",
              data: { message: 123 as unknown as string },
            });
          },
        );

        const t = new InngestTestEngine({
          function: fn,
          events: [{ name: "test", data: { message: "hello" } }],
        });

        const { result, error } = await t.execute();

        expect(JSON.stringify(error)).toContain("failed validation");
        expect(result).toBeUndefined();
      });

      test("should validate an event before sending it (fromSchema)", async () => {
        const inngest = new Inngest({
          id: "test",
          schemas: new EventSchemas().fromSchema({
            test: z.object({
              message: z.string(),
            }),
          }),
          middleware: [validationMiddleware()],
          logger: { error: () => undefined } as Logger,
        });

        const fn = inngest.createFunction(
          { id: "test" },
          { event: "test" },
          async ({ step }) => {
            await step.sendEvent("id", {
              name: "test",
              data: { message: 123 as unknown as string },
            });
          },
        );

        const t = new InngestTestEngine({
          function: fn,
          events: [{ name: "test", data: { message: "hello" } }],
        });

        const { result, error } = await t.execute();

        expect(JSON.stringify(error)).toContain("failed validation");
        expect(result).toBeUndefined();
      });

      test("should not validate an event before sending it if disabled (fromZod)", async () => {
        fetchMock.post(`${baseUrl}/e/${eventKey}`, {
          status: 200,
          ids: ["123"],
        });

        const inngest = new Inngest({
          id: "test",
          fetch: fetchMock as typeof fetch,
          baseUrl,
          eventKey,
          schemas: new EventSchemas().fromZod({
            test: {
              data: z.object({
                message: z.string(),
              }),
            },
          }),
          middleware: [
            validationMiddleware({ disableOutgoingValidation: true }),
          ],
        });

        const fn = inngest.createFunction(
          { id: "test" },
          { event: "test" },
          async ({ step }) => {
            await step.sendEvent("id", {
              name: "test",
              data: { message: 123 as unknown as string },
            });
          },
        );

        const t = new InngestTestEngine({
          function: fn,
          events: [{ name: "test", data: { message: "hello" } }],
        });

        await expect(t.execute()).resolves.not.toThrow();
      });

      test("should not validate an event before sending it if disabled (fromSchema)", async () => {
        fetchMock.post(`${baseUrl}/e/${eventKey}`, {
          status: 200,
          ids: ["123"],
        });

        const inngest = new Inngest({
          id: "test",
          fetch: fetchMock as typeof fetch,
          baseUrl,
          eventKey,
          schemas: new EventSchemas().fromSchema({
            test: z.object({
              message: z.string(),
            }),
          }),
          middleware: [
            validationMiddleware({ disableOutgoingValidation: true }),
          ],
        });

        const fn = inngest.createFunction(
          { id: "test" },
          { event: "test" },
          async ({ step }) => {
            await step.sendEvent("id", {
              name: "test",
              data: { message: 123 as unknown as string },
            });
          },
        );

        const t = new InngestTestEngine({
          function: fn,
          events: [{ name: "test", data: { message: "hello" } }],
        });

        await expect(t.execute()).resolves.not.toThrow();
      });
    });
  });
});
