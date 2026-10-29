/**
 * @module
 * Type tests for factories that forward a middleware list to
 * `agents.agent()`: a list typed as `Middleware.Class[]` loses what the
 * middleware adds to the body, while a factory that is generic over the list
 * (a `const` type parameter) keeps it, also when it puts its own middleware
 * in front of the forwarded list.
 */
import { expectTypeOf } from "vitest";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import type { Middleware } from "../middleware/middleware.ts";
import { sandboxMiddleware } from "../sandbox/middleware.ts";
import type { AgentBody } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import type { ThreadCronEvent } from "./threadTrigger.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);

/**
 * A factory that takes the middleware as a plain list.
 */
const widened = (middleware: Middleware.Class[]) => {
  return agents.agent(
    { id: "widened", on: { cron: "0 * * * *" }, middleware },
    async ({ step }) => {
      // @ts-expect-error a list typed as Middleware.Class[] adds nothing known
      step.sandbox;

      return null;
    },
  );
};

/**
 * A factory that is generic over the list and takes the body from its caller,
 * typed with the same list.
 */
const generic = <const TMiddleware extends Middleware.Class[]>(
  middleware: TMiddleware,
  body: AgentBody<
    ThreadCronEvent,
    null,
    unknown,
    unknown,
    Record<never, never>,
    typeof client,
    TMiddleware
  >,
) => {
  return agents.agent(
    { id: "generic", on: { cron: "0 * * * *" }, middleware },
    body,
  );
};

/**
 * A factory whose body uses what its own middleware adds, and that also
 * forwards the caller's list after it.
 */
const own = <const TMiddleware extends Middleware.Class[]>(
  middleware: TMiddleware,
) => {
  return agents.agent(
    {
      id: "own",
      on: { cron: "0 * * * *" },
      middleware: [sandboxMiddleware(), ...middleware],
    },
    async ({ step }) => {
      expectTypeOf(step.sandbox).toHaveProperty("create");

      return null;
    },
  );
};

describe("forwarded middleware", () => {
  test("a widened list loses the body's extensions, a generic factory keeps them", () => {
    const check = () => {
      widened([sandboxMiddleware()]);
      own([]);

      generic([sandboxMiddleware()], async ({ step, group }) => {
        expectTypeOf(step.sandbox).toHaveProperty("create");
        expectTypeOf(group.sandbox).toBeFunction();

        return null;
      });
    };

    expect(check).toBeTypeOf("function");
  });
});
