import { describe } from "vitest";
import { createBench, createMiddleware, stepPayload } from "./util.ts";

describe("100 parallel step.run", () => {
  createBench({
    name: "0 middleware",
    setup: (client, eventName, onDone) =>
      client.createFunction(
        { id: "fn", retries: 0, triggers: [{ event: eventName }] },
        async ({ step }) => {
          const steps = [];
          for (let i = 0; i < 100; i++) {
            steps.push(step.run(`step-${i}`, () => stepPayload()));
          }
          await Promise.all(steps);
          onDone();
        },
      ),
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
          const steps = [];
          for (let i = 0; i < 100; i++) {
            steps.push(step.run(`step-${i}`, () => stepPayload()));
          }
          await Promise.all(steps);
          onDone();
        },
      );
    },
  });

  createBench({
    name: "5 middleware",
    setup: (client, eventName, onDone) => {
      const middleware = [];
      for (let i = 0; i < 100; i++) {
        middleware.push(createMiddleware());
      }

      return client.createFunction(
        { id: "fn", middleware, retries: 0, triggers: [{ event: eventName }] },
        async ({ step }) => {
          const steps = [];
          for (let i = 0; i < 100; i++) {
            steps.push(step.run(`step-${i}`, () => stepPayload()));
          }
          await Promise.all(steps);
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
      for (let i = 0; i < 100; i++) {
        middleware.push(createMiddleware());
      }

      return client.createFunction(
        { id: "fn", middleware, retries: 0, triggers: [{ event: eventName }] },
        async ({ step }) => {
          const steps = [];
          for (let i = 0; i < 100; i++) {
            steps.push(step.run(`step-${i}`, () => stepPayload()));
          }
          await Promise.all(steps);
          onDone();
        },
      );
    },
  });
});
