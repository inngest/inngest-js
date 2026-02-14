import { describe } from "vitest";
import { Middleware } from "../components/middleware/middleware.ts";
import { makeBench, stepPayload } from "./util.ts";

describe("100 parallel step.run", () => {
  makeBench({
    name: "0 wrapStep",
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

  makeBench({
    name: "1 wrapStep",
    setup: (client, eventName, onDone) => {
      class MW extends Middleware.BaseMiddleware {
        override async wrapStep({ next }: Middleware.WrapStepArgs) {
          return next();
        }
      }

      return client.createFunction(
        {
          id: "fn",
          middleware: [MW],
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

  makeBench({
    name: "5 wrapStep",
    setup: (client, eventName, onDone) => {
      const middleware = [];
      for (let i = 0; i < 100; i++) {
        class MW extends Middleware.BaseMiddleware {
          override async wrapStep({ next }: Middleware.WrapStepArgs) {
            return next();
          }
        }

        middleware.push(MW);
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

  makeBench({
    name: "5 wrapStep; checkpointing",
    checkpointing: true,
    setup: (client, eventName, onDone) => {
      const middleware = [];
      for (let i = 0; i < 100; i++) {
        class MW extends Middleware.BaseMiddleware {
          override async wrapStep({ next }: Middleware.WrapStepArgs) {
            return next();
          }
        }

        middleware.push(MW);
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
