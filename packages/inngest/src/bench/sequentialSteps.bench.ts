import { describe } from "vitest";
import { createBench, createMiddleware, stepPayload } from "./util.ts";

describe("100 sequential step.run", () => {
  createBench({
    name: "0 middleware",
    setup: (client, eventName, onDone) => {
      return client.createFunction(
        { id: "fn", retries: 0, triggers: [{ event: eventName }] },
        async ({ step }) => {
          for (let i = 0; i < 100; i++) {
            await step.run(`step-${i}`, () => stepPayload());
          }
          onDone();
        },
      );
    },
  });

  createBench({
    name: "1 middleware",
    setup: (client, eventName, onDone) => {
      return client.createFunction(
        {
          id: "fn",
          middleware: [createMiddleware()],
          retries: 0,
          triggers: [{ event: eventName }],
        },
        async ({ step }) => {
          for (let i = 0; i < 100; i++) {
            await step.run(`step-${i}`, () => stepPayload());
          }
          onDone();
        },
      );
    },
  });

  createBench({
    name: "5 middleware",
    setup: (client, eventName, onDone) => {
      const middleware = [];
      for (let i = 0; i < 5; i++) {
        middleware.push(createMiddleware());
      }

      return client.createFunction(
        { id: "fn", middleware, retries: 0, triggers: [{ event: eventName }] },
        async ({ step }) => {
          for (let i = 0; i < 100; i++) {
            await step.run(`step-${i}`, () => stepPayload());
          }
          onDone();
        },
      );
    },
  });

  createBench({
    name: "5 middleware; checkpointing",
    checkpointing: true,
    setup: (client, eventName, onDone) => {
      const middleware = [];
      for (let i = 0; i < 5; i++) {
        middleware.push(createMiddleware());
      }

      return client.createFunction(
        { id: "fn", middleware, retries: 0, triggers: [{ event: eventName }] },
        async ({ step }) => {
          for (let i = 0; i < 100; i++) {
            await step.run(`step-${i}`, () => stepPayload());
          }
          onDone();
        },
      );
    },
  });
});
