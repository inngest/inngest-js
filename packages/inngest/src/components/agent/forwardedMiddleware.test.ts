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
import type {
  AgentBody,
  AgentBodyContext,
  AgentTypeDefaults,
  AgentTypesOf,
} from "./agentFunction.ts";
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
  body: AgentBody<{
    event: ThreadCronEvent;
    output: null;
    sandboxes: Record<never, never>;
    client: typeof client;
    middleware: TMiddleware;
  }>,
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

describe("the AgentTypes bag", () => {
  test("a bag names only what it needs, and the rest takes its default", () => {
    expectTypeOf<AgentTypesOf<Record<never, never>>>().toEqualTypeOf<{
      event: AgentTypeDefaults["event"];
      output: unknown;
      request: unknown;
      reply: unknown;
      sandboxes: AgentTypeDefaults["sandboxes"];
      client: AgentTypeDefaults["client"];
      middleware: undefined;
      inboxTools: AgentTypeDefaults["inboxTools"];
    }>();
    expectTypeOf<AgentTypesOf<{ output: number }>["output"]>().toBeNumber();
    expectTypeOf<AgentTypesOf<{ output: number }>["request"]>().toBeUnknown();
    expectTypeOf<AgentBody>().toEqualTypeOf<AgentBody<Record<never, never>>>();
  });

  test("a body type with a bag types its context like the call site does", () => {
    const check = () => {
      const body: AgentBody<{
        event: ThreadCronEvent;
        output: string;
      }> = async ({ event, trigger }) => {
        expectTypeOf(trigger).toEqualTypeOf<ThreadCronEvent | undefined>();
        expectTypeOf(event.data.thread).toBeString();

        return "done";
      };

      expectTypeOf<Parameters<typeof body>[0]>().toEqualTypeOf<
        AgentBodyContext<{ event: ThreadCronEvent }>
      >();

      agents.agent({ id: "bag", on: { cron: "0 * * * *" } }, body);
    };

    expect(check).toBeTypeOf("function");
  });
});

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
