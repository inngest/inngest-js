/**
 * @module
 * Type tests for the function context of an agent's body: it is typed from
 * the client's middleware like the handler of a plain function.
 */
import { expectTypeOf } from "vitest";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { sandboxMiddleware } from "../sandbox/middleware.ts";
import { createAgents } from "./agents.ts";

const plain = createAgents(new Inngest({ id: testClientId }));
const withSandboxes = createAgents(
  new Inngest({ id: testClientId, middleware: [sandboxMiddleware()] }),
);

describe("body context from the client's middleware", () => {
  test("step and group have what the client's middleware adds", () => {
    withSandboxes.agent(
      { id: "ctx-1", on: { cron: "0 * * * *" } },
      async ({ step, group }) => {
        expectTypeOf(step.sandbox).toHaveProperty("create");
        expectTypeOf(group.sandbox).toBeFunction();
        expectTypeOf(step.run).toBeFunction();

        return null;
      },
    );
  });

  test("a client without the middleware has no step.sandbox", () => {
    plain.agent(
      { id: "ctx-2", on: { cron: "0 * * * *" } },
      async ({ step }) => {
        expectTypeOf(step.run).toBeFunction();

        // @ts-expect-error this client has no sandbox middleware
        step.sandbox;

        return null;
      },
    );
  });

  test("the agent's fields are still there, and event is the agent's", () => {
    withSandboxes.agent(
      { id: "ctx-3", on: { cron: "0 * * * *" } },
      async ({ event, inbox, thread, runId, logger }) => {
        expectTypeOf(event.data.thread).toBeString();
        expectTypeOf(inbox).toHaveProperty("next");
        expectTypeOf(thread).toHaveProperty("send");
        expectTypeOf(runId).toBeString();
        expectTypeOf(logger).toHaveProperty("info");

        return null;
      },
    );
  });

  test("the agent's own middleware option types the body like the client's", () => {
    plain.agent(
      {
        id: "ctx-4",
        on: { cron: "0 * * * *" },
        middleware: [sandboxMiddleware()],
      },
      async ({ step, group }) => {
        expectTypeOf(step.sandbox).toHaveProperty("create");
        expectTypeOf(group.sandbox).toBeFunction();
        expectTypeOf(step.run).toBeFunction();

        return null;
      },
    );

    plain.agent(
      { id: "ctx-5", on: { cron: "0 * * * *" } },
      async ({ step }) => {
        // @ts-expect-error this agent has no middleware that adds step.sandbox
        step.sandbox;

        return null;
      },
    );
  });
});
