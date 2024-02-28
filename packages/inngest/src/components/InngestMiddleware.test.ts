/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ExecutionVersion } from "@local/components/execution/InngestExecution";
import { Inngest } from "@local/components/Inngest";
import { referenceFunction } from "@local/components/InngestFunctionReference";
import { InngestMiddleware } from "@local/components/InngestMiddleware";
import { StepOpCode } from "@local/types";
import { type IsUnknown } from "type-fest";
import { assertType, type IsEqual } from "type-plus";
import { createClient, runFnWithStack, testClientId } from "../test/helpers";

describe("stacking and inference", () => {
  describe("onFunctionRun", () => {
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
        const mw = new InngestMiddleware({
          name: "mw",
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

        const inngest = new Inngest({ id: "test", middleware: [mw] });

        test("input context has value", () => {
          inngest.createFunction(
            {
              id: "",
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["foo"], string>>(true);
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["foo"], string>>(true);
            }
          );
        });
      });

      describe("can add a literal value to input context", () => {
        const mw = new InngestMiddleware({
          name: "mw",
          init() {
            return {
              onFunctionRun() {
                return {
                  transformInput() {
                    return {
                      ctx: { foo: "bar" },
                    } as const;
                  },
                };
              },
            };
          },
        });

        const inngest = new Inngest({ id: "test", middleware: [mw] });

        test("input context has value", () => {
          inngest.createFunction(
            {
              id: "",
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["foo"], "bar">>(true);
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["foo"], "bar">>(true);
            }
          );
        });
      });

      describe("can mutate an existing input context value", () => {
        const mw = new InngestMiddleware({
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

        const inngest = new Inngest({ id: "test", middleware: [mw] });

        test("input context has value", () => {
          inngest.createFunction(
            {
              id: "",
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["event"], boolean>>(true);
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["event"], boolean>>(true);
            }
          );
        });
      });

      describe("can add multiple input context values via stacking", () => {
        const mw1 = new InngestMiddleware({
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

        const mw2 = new InngestMiddleware({
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

        const inngest = new Inngest({ id: "test", middleware: [mw1, mw2] });

        test("input context has foo value", () => {
          inngest.createFunction(
            {
              id: "",
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["foo"], string>>(true);
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["foo"], string>>(true);
            }
          );
        });

        test("input context has bar value", () => {
          inngest.createFunction(
            {
              id: "",
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["bar"], boolean>>(true);
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["bar"], boolean>>(true);
            }
          );
        });
      });

      describe("can overwrite a new value in input context", () => {
        const mw1 = new InngestMiddleware({
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

        const mw2 = new InngestMiddleware({
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

        const inngest = new Inngest({ id: "test", middleware: [mw1, mw2] });

        test("input context has new value", () => {
          inngest.createFunction(
            {
              id: "",
              onFailure: (ctx) => {
                assertType<IsEqual<(typeof ctx)["foo"], boolean>>(true);
              },
            },
            { event: "" },
            (ctx) => {
              assertType<IsEqual<(typeof ctx)["foo"], boolean>>(true);
            }
          );
        });
      });
    });
  });

  describe("onSendEvent", () => {
    describe("transformInput", () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mockFetch = jest.fn(() =>
        Promise.resolve({
          status: 200,
          json: () => Promise.resolve({ ids: [], status: 200 }),
          text: () => Promise.resolve(""),
        })
      ) as any;

      beforeEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
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
            }
          );

          const res = await runFnWithStack(
            fn,
            {},
            { executionVersion: ExecutionVersion.V1 }
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
            }
          );

          const res = await runFnWithStack(
            fn,
            {},
            { executionVersion: ExecutionVersion.V1 }
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
            }
          );

          const res = await runFnWithStack(
            fn,
            {},
            { executionVersion: ExecutionVersion.V1 }
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
          const transformInputSpy = jest.fn(() => undefined);

          const onSendEventSpy = jest.fn(() => ({
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
            }
          );

          await runFnWithStack(
            fn,
            {},
            { executionVersion: ExecutionVersion.V1 }
          );

          expect(onSendEventSpy).toHaveBeenCalledTimes(2);
          expect(transformInputSpy).toHaveBeenCalledTimes(2);
        });
      });
    });

    describe("transformOutput", () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mockFetch = jest.fn(() =>
        Promise.resolve({
          status: 200,
          json: () => Promise.resolve({ ids: [], status: 200 }),
          text: () => Promise.resolve(""),
        })
      ) as any;

      beforeEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
              true
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
              true
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          fetch: mockFetch,
        });

        const payload = { name: "foo", data: { foo: "bar" } };

        test("output context has value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["ids"], boolean>>(
              true
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
              true
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          fetch: mockFetch,
        });

        const payload = { name: "foo", data: { foo: "bar" } };

        test("output context has new value", () => {
          inngest.createFunction({ id: "" }, { event: "" }, ({ step }) => {
            const directRes = inngest.send(payload);
            assertType<IsEqual<Awaited<typeof directRes>["foo"], boolean>>(
              true
            );

            const res = step.sendEvent("id", payload);
            assertType<IsEqual<Awaited<typeof res>["foo"], boolean>>(true);
          });
        });
      });
    });
  });
});
