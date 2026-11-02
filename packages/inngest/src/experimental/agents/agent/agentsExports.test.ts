/**
 * @module
 * Type tests for the public entry `inngest/experimental/agents`: the types
 * that name an `AgentTypes` bag and an agent's body context are exported, so
 * a helper outside an `agents.agent()` call can type what the body gets, and
 * and `InboxMessage` names the messages of an agent's inbox.
 */
import { expectTypeOf, test } from "vitest";
import { z } from "zod/v4";
import { Inngest } from "../../../components/Inngest.ts";
import type { Middleware } from "../../../components/middleware/middleware.ts";
import { sandboxMiddleware } from "../../../components/sandbox/middleware.ts";
import { eventType } from "../../../components/triggers/triggers.ts";
import type {
  AgentBodyContext,
  AgentTypes,
  AgentTypesOf,
  InboxMessage,
  InboxSource,
  InboxToolsConfig,
  SandboxToolNames,
  ThreadInbox,
  TriggerEvent,
} from "../index.ts";

test("every field of an AgentTypes bag can be named from the entry", () => {
  const client = new Inngest({
    id: "exports",
    middleware: [sandboxMiddleware()],
  });

  type Bag = AgentTypes & {
    event: TriggerEvent;
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
  expectTypeOf<AgentTypesOf<Bag>["event"]>().toEqualTypeOf<TriggerEvent>();
});

test("the inbox of an agent is a core Inbox, and InboxMessage names its messages", () => {
  const check = async (inbox: ThreadInbox) => {
    const message: InboxMessage<typeof inbox> | undefined = await inbox.next();

    expectTypeOf(message).toEqualTypeOf<
      InboxMessage<ThreadInbox> | undefined
    >();
    expectTypeOf(inbox).toExtend<AsyncDisposable>();

    const source: InboxSource = { event: "x", if: "true" };

    void source;
  };

  expectTypeOf(check).toBeFunction();
});
