/**
 * @module
 * Type tests for factories that forward a middleware list to
 * `agents.agent()`: a list typed as `Middleware.Class[]` loses what the
 * middleware adds to the body, while a factory that is generic over the list
 * (a `const` type parameter) keeps it, also when it puts its own middleware
 * in front of the forwarded list.
 */
import { expectTypeOf } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import type { Middleware } from "../../../components/middleware/middleware.ts";
import { sandboxMiddleware } from "../../../components/sandbox/middleware.ts";
import { testClientId } from "../../../test/helpers.ts";
import type { ThreadCronEvent } from "../threads/threadTrigger.ts";
import { createAgents } from "./agents.ts";
import type {
  AgentBody,
  AgentBodyContext,
  AgentTypeDefaults,
  AgentTypesOf,
} from "./types.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);

/**
 * A factory that takes the middleware as a plain list.
 */
const widened = (middleware: Middleware.Class[]) => {
  return agents.agent(
    { id: "widened", triggers: { cron: "0 * * * *" }, middleware },
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
    { id: "generic", triggers: { cron: "0 * * * *" }, middleware },
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
      triggers: { cron: "0 * * * *" },
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
      sandboxes: AgentTypeDefaults["sandboxes"];
      client: AgentTypeDefaults["client"];
      middleware: undefined;
      sources: undefined;
      model: undefined;
    }>();
    expectTypeOf<AgentTypesOf<{ output: number }>["output"]>().toBeNumber();
    expectTypeOf<AgentTypesOf<{ output: number }>["event"]>().toEqualTypeOf<
      AgentTypeDefaults["event"]
    >();
    expectTypeOf<AgentBody>().toEqualTypeOf<AgentBody<Record<never, never>>>();
  });

  test("a body type with a bag types its context like the call site does", () => {
    const check = () => {
      const body: AgentBody<{
        event: ThreadCronEvent;
        output: string;
      }> = async ({ event, me }) => {
        expectTypeOf(event.data.cron).toBeString();
        expectTypeOf(me.key).toBeString();

        return "done";
      };

      expectTypeOf<Parameters<typeof body>[0]>().toEqualTypeOf<
        AgentBodyContext<{ event: ThreadCronEvent }>
      >();

      agents.agent({ id: "bag", triggers: { cron: "0 * * * *" } }, body);
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
