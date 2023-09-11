/* eslint-disable @typescript-eslint/no-explicit-any */
import { Inngest } from "@local/components/Inngest";
import { InngestMiddleware } from "@local/components/InngestMiddleware";
import { assertType, type IsEqual } from "type-plus";

describe("stacking and inference", () => {
  describe("onFunctionRun", () => {
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
    describe("transformOutput", () => {
      const originalFetch = global.fetch;

      beforeAll(() => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        global.fetch = jest.fn(() =>
          Promise.resolve({ status: 200, json: () => Promise.resolve({}) })
        ) as any;
      });

      beforeEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        (global.fetch as any).mockClear();
      });

      afterAll(() => {
        global.fetch = originalFetch;
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
        });

        test("output context has value", () => {
          const res = inngest.send({ name: "foo", data: { foo: "bar" } });
          assertType<IsEqual<Awaited<typeof res>["foo"], string>>(true);
        });

        test("output context retains default 'ids' value", () => {
          const res = inngest.send({ name: "foo", data: { foo: "bar" } });
          assertType<IsEqual<Awaited<typeof res>["ids"], string[]>>(true);
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
        });

        test("output context has value", () => {
          const res = inngest.send({ name: "foo", data: { foo: "bar" } });
          assertType<IsEqual<Awaited<typeof res>["foo"], "bar">>(true);
        });

        test("output context retains default 'ids' value", () => {
          const res = inngest.send({ name: "foo", data: { foo: "bar" } });
          assertType<IsEqual<Awaited<typeof res>["ids"], string[]>>(true);
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
        });

        test("output context has value", () => {
          const res = inngest.send({ name: "foo", data: { foo: "bar" } });
          assertType<IsEqual<Awaited<typeof res>["ids"], boolean>>(true);
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
        });

        test("output context has foo value", () => {
          const res = inngest.send({ name: "foo", data: { foo: "bar" } });
          assertType<IsEqual<Awaited<typeof res>["foo"], string>>(true);
        });

        test("output context has bar value", () => {
          const res = inngest.send({ name: "foo", data: { foo: "bar" } });
          assertType<IsEqual<Awaited<typeof res>["bar"], boolean>>(true);
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
        });

        test("output context has new value", () => {
          const res = inngest.send({ name: "foo", data: { foo: "bar" } });
          assertType<IsEqual<Awaited<typeof res>["foo"], boolean>>(true);
        });
      });
    });
  });
});
