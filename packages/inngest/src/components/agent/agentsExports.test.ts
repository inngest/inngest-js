/**
 * @module
 * Type tests for the public entry `inngest/experimental/agents`: the types
 * that name an `AgentTypes` bag and an agent's body context are exported, so
 * a helper outside an `agents.agent()` call can type what the body gets, and
 * the listener `inbox.listen()` returns is a typed view.
 */
import { expectTypeOf, test } from "vitest";
import { z } from "zod/v4";
import type {
  AgentBodyContext,
  AgentTypes,
  AgentTypesOf,
  EventMessage,
  InboxListenOptions,
  InboxSource,
  InboxToolsConfig,
  SandboxToolNames,
  ThreadInbox,
  ThreadListener,
  TriggerEvent,
  View,
} from "../../experimental/agents/index.ts";
import { Inngest } from "../Inngest.ts";
import type { Middleware } from "../middleware/middleware.ts";
import { sandboxMiddleware } from "../sandbox/middleware.ts";
import { eventType } from "../triggers/triggers.ts";

test("every field of an AgentTypes bag can be named from the entry", () => {
  const client = new Inngest({
    id: "exports",
    middleware: [sandboxMiddleware()],
  });

  type Bag = AgentTypes & {
    event: TriggerEvent;
    request: { ask: string };
    reply: { answer: string };
    sandboxes: SandboxToolNames;
    client: typeof client;
    middleware: Middleware.Class[] | undefined;
    inboxTools: InboxToolsConfig | undefined;
  };

  const helper = (context: AgentBodyContext<Bag>) => {
    expectTypeOf(context.inbox).toExtend<ThreadInbox>();
    expectTypeOf(context.thread).toHaveProperty("key");
  };

  expectTypeOf(helper).toBeFunction();
  expectTypeOf<AgentTypesOf<Bag>["request"]>().toEqualTypeOf<{ ask: string }>();
});

test("a listener is the typed view of its event", () => {
  const status = eventType("ci/status", {
    schema: z.object({ state: z.string() }),
  });
  const check = async (inbox: ThreadInbox) => {
    const listener = await inbox.listen(status, { thread: "event.data.t" });

    expectTypeOf(listener).toEqualTypeOf<ThreadListener<typeof status>>();
    expectTypeOf(listener).toExtend<View<EventMessage<typeof status>>>();
    expectTypeOf(listener).toExtend<AsyncDisposable>();

    const message = await listener.next({ timeout: "1m" });

    if (message) {
      expectTypeOf(message.data.state).toBeString();
    }

    const fromSource = await inbox.listen({ event: status, if: "true" });

    expectTypeOf(fromSource).toEqualTypeOf<ThreadListener<typeof status>>();

    const source: InboxSource = { event: "x", if: "true" };
    const options: InboxListenOptions = { if: "true" };

    void source;
    void options;
  };

  expectTypeOf(check).toBeFunction();
});
