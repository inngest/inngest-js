import { ExecutionVersion } from "../helpers/consts.ts";
import type { IsEqual, IsUnknown } from "../helpers/types.ts";
import { createClient, runFnWithStack, testClientId } from "../test/helpers.ts";
import { StepOpCode } from "../types.ts";
import { Inngest } from "./Inngest.ts";
import { referenceFunction } from "./InngestFunctionReference.ts";
import { InngestMiddleware } from "./InngestMiddleware.ts";
import { NonRetriableError } from "./NonRetriableError.ts";

describe("stacking and inference", () => {
  describe("onFunctionRun", () => {
    test("ordered correctly", async () => {
      const logs: string[] = [];

      const createMw = (name: string) => {
        return new InngestMiddleware({
          name,
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    logs.push(`${name} transformInput`);
                  },
                  beforeMemoization() {
                    logs.push(`${name} beforeMemoization`);
                  },
                  afterMemoization() {
                    logs.push(`${name} afterMemoization`);
                  },
                  beforeExecution() {
                    logs.push(`${name} beforeExecution`);
                  },
                  afterExecution() {
                    logs.push(`${name} afterExecution`);
                  },
                  transformOutput() {
                    logs.push(`${name} transformOutput`);
                  },
                  beforeResponse() {
                    logs.push(`${name} beforeResponse`);
                  },
                  finished() {
                    logs.push(`${name} finished`);
                  },
                };
              },
            };
          },
        });
      };

      const mwFoo = createMw("foo");
      const mwBar = createMw("bar");

      const client = createClient({
        id: testClientId,
        middleware: [mwFoo, mwBar],
      });

      const fn = client.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        () => {
          return "success";
        },
      );

      await runFnWithStack(fn, {}, { event: { data: {}, name: "test/event" } });

      // Expected onion pattern:
      // Forward hooks: foo -> bar
      // Backward hooks: bar -> foo
      expect(logs).toEqual([
        // Forward direction
        "foo transformInput",
        "bar transformInput",
        "foo beforeMemoization",
        "bar beforeMemoization",
        // Backward direction (onion pattern)
        "bar afterMemoization",
        "foo afterMemoization",
        "foo beforeExecution",
        "bar beforeExecution",
        // Backward direction (onion pattern)
        "bar afterExecution",
        "foo afterExecution",
        "bar transformOutput",
        "foo transformOutput",
        // Forward direction - finished comes before beforeResponse
        "foo finished",
        "bar finished",
        "foo beforeResponse",
        "bar beforeResponse",
      ]);
    });

    test("has `reqArgs`", () => {
      new InngestMiddleware({
        name: "mw",
        init() {
          return {
            onFunctionRun({ reqArgs }) {
              assertType<IsEqual<typeof reqArgs, readonly unknown[]>>(true);
              assertType<IsUnknown<(typeof reqArgs)[number]>>(true);

              return {
                transformInput({ reqArgs }) {
                  assertType<IsEqual<typeof reqArgs, readonly unknown[]>>(true);
                  assertType<IsUnknown<(typeof reqArgs)[number]>>(true);
                },
              };
            },
          };
        },
      });
    });

    describe("transformInput", () => {
      describe("can add a value to input context", () => {
        const clientMw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { foo: "foo" },
                    };
                  },
                };
              },
            };
          },
        });

        const fnMw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { bar: "bar" },
                    };
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({ id: "test", middleware: [clientMw] });

        test("input context has value", () => {
          inngest.createFunction(
            {
              id: "",
              middleware: [fnMw],
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["foo"], string>>(true);
                expect(ctx.foo).toBe("foo");

                assertType<IsEqual<(typeof ctx)["bar"], string>>(true);
                expect(ctx.bar).toBe("bar");
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["foo"], string>>(true);
              expect(ctx.foo).toBe("foo");

              assertType<IsEqual<(typeof ctx)["bar"], string>>(true);
              expect(ctx.bar).toBe("bar");
            },
          );
        });
      });

      describe("can add a literal value to input context", () => {
        const clientMw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { foo: "foo" },
                    } as const;
                  },
                };
              },
            };
          },
        });

        const fnMw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { bar: "bar" },
                    } as const;
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({
          id: "test",
          middleware: [clientMw],
        });

        test("input context has value", () => {
          inngest.createFunction(
            {
              id: "",
              middleware: [fnMw],
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["foo"], "foo">>(true);
                expect(ctx.foo).toBe("foo");

                assertType<IsEqual<(typeof ctx)["bar"], "bar">>(true);
                expect(ctx.bar).toBe("bar");
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["foo"], "foo">>(true);
              expect(ctx.foo).toBe("foo");

              assertType<IsEqual<(typeof ctx)["bar"], "bar">>(true);
              expect(ctx.bar).toBe("bar");
            },
          );
        });
      });

      describe("can mutate an existing input context value", () => {
        const clientMw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { event: true },
                    };
                  },
                };
              },
            };
          },
        });

        const fnMw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { step: true },
                    };
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({ id: "test", middleware: [clientMw] });

        test("input context has value", () => {
          inngest.createFunction(
            {
              id: "",
              middleware: [fnMw],
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["event"], boolean>>(true);
                expect(ctx.event).toBe(true);

                assertType<IsEqual<(typeof ctx)["step"], boolean>>(true);
                expect(ctx.step).toBe(true);
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["event"], boolean>>(true);
              expect(ctx.event).toBe(true);

              assertType<IsEqual<(typeof ctx)["step"], boolean>>(true);
              expect(ctx.step).toBe(true);
            },
          );
        });
      });

      describe("can add multiple input context values via stacking", () => {
        const clientMw1 = new InngestMiddleware({
          name: "mw1",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { foo: "foo" },
                    };
                  },
                };
              },
            };
          },
        });

        const clientMw2 = new InngestMiddleware({
          name: "mw2",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { bar: true },
                    };
                  },
                };
              },
            };
          },
        });

        const fnMw1 = new InngestMiddleware({
          name: "mw1",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { fooFn: "foo" },
                    };
                  },
                };
              },
            };
          },
        });

        const fnMw2 = new InngestMiddleware({
          name: "mw2",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { barFn: true },
                    };
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({
          id: "test",
          middleware: [clientMw1, clientMw2],
        });

        test("input context has foo value", () => {
          inngest.createFunction(
            {
              id: "",
              middleware: [fnMw1, fnMw2],
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["foo"], string>>(true);
                expect(ctx.foo).toBe("foo");

                assertType<IsEqual<(typeof ctx)["fooFn"], string>>(true);
                expect(ctx.fooFn).toBe("foo");
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["foo"], string>>(true);
              expect(ctx.foo).toBe("foo");

              assertType<IsEqual<(typeof ctx)["fooFn"], string>>(true);
              expect(ctx.fooFn).toBe("foo");
            },
          );
        });

        test("input context has bar value", () => {
          inngest.createFunction(
            {
              id: "",
              middleware: [fnMw1, fnMw2],
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["bar"], boolean>>(true);
                expect(ctx.bar).toBe(true);

                assertType<IsEqual<(typeof ctx)["barFn"], boolean>>(true);
                expect(ctx.barFn).toBe(true);
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["bar"], boolean>>(true);
              expect(ctx.bar).toBe(true);

              assertType<IsEqual<(typeof ctx)["barFn"], boolean>>(true);
              expect(ctx.barFn).toBe(true);
            },
          );
        });
      });

      describe("can overwrite a new value in input context", () => {
        const clientMw1 = new InngestMiddleware({
          name: "mw1",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { foo: "bar" },
                    };
                  },
                };
              },
            };
          },
        });

        const clientMw2 = new InngestMiddleware({
          name: "mw2",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { foo: true },
                    };
                  },
                };
              },
            };
          },
        });

        const fnMw1 = new InngestMiddleware({
          name: "mw1",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { foo: [] },
                    };
                  },
                };
              },
            };
          },
        });

        const fnMw2 = new InngestMiddleware({
          name: "mw2",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { foo: 123 },
                    };
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({
          id: "test",
          middleware: [clientMw1, clientMw2],
        });

        test("input context has new value", () => {
          inngest.createFunction(
            {
              id: "",
              middleware: [fnMw1, fnMw2],
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["foo"], number>>(true);
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["foo"], number>>(true);
            },
          );
        });
      });
    });

    describe("transformOutput", () => {
      test("can see an error in output context", async () => {
        let error: Error | undefined;

        const fn = new Inngest({
          id: "test",
          middleware: [
            new InngestMiddleware({
              name: "mw",
              init() {
                return {
                  onFunctionRun() {
                    return {
                      transformOutput({ result }) {
                        error = result.error as Error;
                      },
                    };
                  },
                };
              },
            }),
          ],
        }).createFunction({ id: "" }, { event: "" }, () => {
          throw new Error("test error");
        });

        await runFnWithStack(fn, {}, { executionVersion: ExecutionVersion.V1 });

        expect(error).toBeInstanceOf(Error);
      });

      test("can overwrite an existing error in output context", async () => {
        const fn = new Inngest({
          id: "test",
          middleware: [
            new InngestMiddleware({
              name: "mw1",
              init() {
                return {
                  onFunctionRun() {
                    return {
                      transformOutput() {
                        return {
                          result: { error: new Error("foo") },
                        };
                      },
                    };
                  },
                };
              },
            }),
            new InngestMiddleware({
              name: "mw2",
              init() {
                return {
                  onFunctionRun() {
                    return {
                      transformOutput() {
                        return {
                          result: { error: new Error("bar") },
                        };
                      },
                    };
                  },
                };
              },
            }),
          ],
        }).createFunction({ id: "" }, { event: "" }, () => {
          throw new Error("test error");
        });

        const res = await runFnWithStack(
          fn,
          {},
          { executionVersion: ExecutionVersion.V1 },
        );

        expect(res).toMatchObject({
          type: "function-rejected",
          error: { message: "foo" },
          retriable: true,
        });
      });

      test("can set a NonRetriableError", async () => {
        const fn = new Inngest({
          id: "test",
          middleware: [
            new InngestMiddleware({
              name: "mw1",
              init() {
                return {
                  onFunctionRun() {
                    return {
                      transformOutput() {
                        return {
                          result: { error: new NonRetriableError("foo") },
                        };
                      },
                    };
                  },
                };
              },
            }),
          ],
        }).createFunction({ id: "" }, { event: "" }, () => {
          throw new Error("test error");
        });

        const res = await runFnWithStack(
          fn,
          {},
          { executionVersion: ExecutionVersion.V1 },
        );

        expect(res).toMatchObject({
          type: "function-rejected",
          error: { message: "foo" },
          retriable: false,
        });
      });
    });
  });

  describe("onSendEvent", () => {
    describe("transformInput", () => {
      const mockFetch = vi.fn(
        () =>
          Promise.resolve({
            status: 200,
            json: () => Promise.resolve({ ids: [], status: 200 }),
            text: () => Promise.resolve(""),
          }),
        // biome-ignore lint/suspicious/noExplicitAny: intentional
      ) as any;

      beforeEach(() => {
        mockFetch.mockClear();
      });

      describe("step.invoke()", () => {
        test("returning a new payload overwrites the original", async () => {
          const fn = createClient({
            id: testClientId,
            middleware: [
              new InngestMiddleware({
                name: "Test: onSendEvent.transformInput",
                init() {
                  return {
                    onSendEvent() {
                      return {
                        transformInput() {
                          return {
                            payloads: [
                              {
                                name: "foo",
                                data: { dataFromMiddleware: true },
                              },
                            ],
                          };
                        },
                      };
                    },
                  };
                },
              }),
            ],
          }).createFunction(
            { id: "fn_id" },
            { event: "foo" },
            async ({ step }) => {
              await step.invoke("id", {
                function: referenceFunction({
                  functionId: "some_fn_id",
                  data: { dataFromStep: true },
                }),
              });
            },
          );

          const res = await runFnWithStack(
            fn,
            {},
            { executionVersion: ExecutionVersion.V1 },
          );

          expect(res).toMatchObject({
            steps: [
              expect.objectContaining({
                op: StepOpCode.InvokeFunction,
                opts: expect.objectContaining({
                  payload: {
                    data: { dataFromMiddleware: true },
                  },
                }),
              }),
            ],
          });
        });

        test("returning no payload keeps the original", async () => {
          const fn = createClient({
            id: testClientId,
            middleware: [
              new InngestMiddleware({
                name: "Test: onSendEvent.transformInput",
                init() {
                  return {
                    onSendEvent() {
                      return {
                        transformInput() {
                          return {
                            payloads: [],
                          };
                        },
                      };
                    },
                  };
                },
              }),
            ],
          }).createFunction(
            { id: "fn_id" },
            { event: "foo" },
            async ({ step }) => {
              await step.invoke("id", {
                function: referenceFunction({
                  functionId: "some_fn_id",
                }),
                data: { dataFromStep: true },
              });
            },
          );

          const res = await runFnWithStack(
            fn,
            {},
            { executionVersion: ExecutionVersion.V1 },
          );

          expect(res).toMatchObject({
            steps: [
              expect.objectContaining({
                op: StepOpCode.InvokeFunction,
                opts: expect.objectContaining({
                  payload: {
                    data: { dataFromStep: true },
                  },
                }),
              }),
            ],
          });
        });

        test("returning a partial payload merges with the original, preferring the new value", async () => {
          const fn = createClient({
            id: testClientId,
            middleware: [
              new InngestMiddleware({
                name: "Test: onSendEvent.transformInput",
                init() {
                  return {
                    onSendEvent() {
                      return {
                        transformInput() {
                          return {
                            payloads: [
                              {
                                name: "foo",
                                user: { userFromMiddleware: true },
                              },
                            ],
                          };
                        },
                      };
                    },
                  };
                },
              }),
            ],
          }).createFunction(
            { id: "fn_id" },
            { event: "foo" },
            async ({ step }) => {
              await step.invoke("id", {
                function: referenceFunction({
                  functionId: "some_fn_id",
                }),
                data: { dataFromStep: true },
              });
            },
          );

          const res = await runFnWithStack(
            fn,
            {},
            { executionVersion: ExecutionVersion.V1 },
          );

          expect(res).toMatchObject({
            steps: [
              expect.objectContaining({
                op: StepOpCode.InvokeFunction,
                opts: expect.objectContaining({
                  payload: {
                    data: {
                      dataFromStep: true,
                    },
                    user: {
                      userFromMiddleware: true,
                    },
                  },
                }),
              }),
            ],
          });
        });

        test("hook runs once per invocation", async () => {
          const transformInputSpy = vi.fn(() => undefined);

          const onSendEventSpy = vi.fn(() => ({
            transformInput: transformInputSpy,
          }));

          const fn = createClient({
            id: testClientId,
            middleware: [
              new InngestMiddleware({
                name: "Test: onSendEvent.transformInput",
                init() {
                  return {
                    onSendEvent: onSendEventSpy,
                  };
                },
              }),
            ],
          }).createFunction(
            { id: "fn_id" },
            { event: "foo" },
            async ({ step }) => {
              await Promise.all([
                step.invoke("id", {
                  function: referenceFunction({
                    functionId: "some_fn_id",
                    data: { dataFromStep: true },
                  }),
                }),
                step.invoke("id", {
                  function: referenceFunction({
                    functionId: "some_fn_id",
                    data: { dataFromStep: true },
                  }),
                }),
              ]);
            },
          );

          await runFnWithStack(
            fn,
            {},
            { executionVersion: ExecutionVersion.V1 },
          );

          expect(onSendEventSpy).toHaveBeenCalledTimes(2);
          expect(transformInputSpy).toHaveBeenCalledTimes(2);
        });
      });
    });

    describe("transformOutput", () => {
      const mockFetch = vi.fn(
        () =>
          Promise.resolve({
            status: 200,
            json: () => Promise.resolve({ ids: [], status: 200 }),
            text: () => Promise.resolve(""),
          }),
        // biome-ignore lint/suspicious/noExplicitAny: intentional
      ) as any;

      beforeEach(() => {
        mockFetch.mockClear();
      });

      describe("can add a value to output context", () => {
        const mw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onSendEvent() {
                return {
                  transformOutput() {
                    return {
                      result: { foo: "bar" },
                    };
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({
          id: "test",
          middleware: [mw],
          eventKey: "123",

          fetch: mockFetch,
        });

        const payload = { name: "foo", data: { foo: "bar" } };

        test("output context has value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["foo"], string>>(true);

            const res = step.sendEvent("id", payload);
            assertType<IsEqual<Awaited<typeof res>["foo"], string>>(true);
          });
        });

        test("output context retains default 'ids' value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["ids"], string[]>>(
              true,
            );

            const res = step.sendEvent("id", payload);
            assertType<IsEqual<Awaited<typeof res>["ids"], string[]>>(true);
          });
        });
      });

      describe("can add a literal value to output context", () => {
        const mw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onSendEvent() {
                return {
                  transformOutput() {
                    return {
                      result: { foo: "bar" },
                    } as const;
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({
          id: "test",
          middleware: [mw],
          eventKey: "123",

          fetch: mockFetch,
        });

        const payload = { name: "foo", data: { foo: "bar" } };

        test("output context has value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["foo"], "bar">>(true);

            const res = step.sendEvent("id", payload);
            assertType<IsEqual<Awaited<typeof res>["foo"], "bar">>(true);
          });
        });

        test("output context retains default 'ids' value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["ids"], string[]>>(
              true,
            );

            const res = step.sendEvent("id", payload);
            assertType<IsEqual<Awaited<typeof res>["ids"], string[]>>(true);
          });
        });
      });

      describe("can mutate an existing output context value", () => {
        const mw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onSendEvent() {
                return {
                  transformOutput() {
                    return {
                      result: { ids: true },
                    };
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({
          id: "test",
          middleware: [mw],
          eventKey: "123",

          fetch: mockFetch,
        });

        const payload = { name: "foo", data: { foo: "bar" } };

        test("output context has value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["ids"], boolean>>(
              true,
            );

            const res = step.sendEvent("id", payload);
            assertType<IsEqual<Awaited<typeof res>["ids"], boolean>>(true);
          });
        });
      });

      describe("can add multiple output context values via stacking", () => {
        const mw1 = new InngestMiddleware({
          name: "mw1",
          init() {
            return {
              onSendEvent() {
                return {
                  transformOutput() {
                    return {
                      result: { foo: "foo" },
                    };
                  },
                };
              },
            };
          },
        });

        const mw2 = new InngestMiddleware({
          name: "mw2",
          init() {
            return {
              onSendEvent() {
                return {
                  transformOutput() {
                    return {
                      result: { bar: true },
                    };
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({
          id: "test",
          middleware: [mw1, mw2],
          eventKey: "123",

          fetch: mockFetch,
        });

        const payload = { name: "foo", data: { foo: "bar" } };

        test("output context has foo value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["foo"], string>>(true);

            const res = step.sendEvent("id", payload);
            assertType<IsEqual<Awaited<typeof res>["foo"], string>>(true);
          });
        });

        test("output context has bar value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["bar"], boolean>>(
              true,
            );

            const res = step.sendEvent("id", payload);
            assertType<IsEqual<Awaited<typeof res>["bar"], boolean>>(true);
          });
        });
      });

      describe("can overwrite a new value in output context", () => {
        const mw1 = new InngestMiddleware({
          name: "mw1",
          init() {
            return {
              onSendEvent() {
                return {
                  transformOutput() {
                    return {
                      result: { foo: "bar" },
                    };
                  },
                };
              },
            };
          },
        });

        const mw2 = new InngestMiddleware({
          name: "mw2",
          init() {
            return {
              onSendEvent() {
                return {
                  transformOutput() {
                    return {
                      result: { foo: true },
                    };
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({
          id: "test",
          middleware: [mw1, mw2],
          eventKey: "123",

          fetch: mockFetch,
        });

        const payload = { name: "foo", data: { foo: "bar" } };

        test("output context has new value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["foo"], boolean>>(
              true,
            );

            const res = step.sendEvent("id", payload);
            assertType<IsEqual<Awaited<typeof res>["foo"], boolean>>(true);
          });
        });
      });
    });
  });
});
