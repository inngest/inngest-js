/**
 * @module
 * Type tests for the agent's inbox: a core `Inbox` of `AgentMessage`.
 */
import { z } from "zod";
import { eventType } from "../../../components/triggers/triggers.ts";
import { agents, closed, created, typesOnly } from "../agent/typeFixtures.ts";
import type * as entry from "../index.ts";
import type { AgentMessage, Inbox, InboxMessage } from "../index.ts";

const reviewed = eventType("pr/reviewed", {
  schema: z.object({ pr: z.string() }),
});

describe("inbox", () => {
  test("inbox: the agents entry re-exports the core Inbox", () => {
    expectTypeOf<Inbox<AgentMessage>>().toEqualTypeOf<
      import("../../../components/inbox/Inbox.ts").Inbox<AgentMessage>
    >();
    expectTypeOf<keyof typeof entry>().not.toEqualTypeOf<"ThreadInbox">();
  });

  test("inbox: reads return the documented types", () => {
    typesOnly(() => {
      agents.agent(
        { id: "inbox-1", triggers: [created] },
        async ({ inbox }) => {
          const next = await inbox.next();

          expectTypeOf(next).toEqualTypeOf<
            InboxMessage<typeof inbox> | undefined
          >();

          const timed = await inbox.next({ timeout: "1s" });

          expectTypeOf(timed).toEqualTypeOf<
            InboxMessage<typeof inbox> | null | undefined
          >();
          expectTypeOf(await inbox.drain()).toBeArray();
          expectTypeOf(inbox).not.toHaveProperty("listen");
          expectTypeOf(inbox).not.toHaveProperty("of");
        },
      );
    });
  });

  test("inbox: a trigger message narrows by is()", () => {
    typesOnly(() => {
      agents.agent(
        { id: "inbox-2", triggers: [created, closed] },
        async ({ inbox }) => {
          const message = await inbox.next();

          if (message?.is(created)) {
            expectTypeOf(message.data.total).toBeNumber();
          }
        },
      );
    });
  });

  test("inbox: messages from an inbox source join the agent's message type", () => {
    typesOnly(() => {
      agents.agent(
        {
          id: "inbox-3",
          triggers: [created],
          inbox: [{ event: reviewed, thread: "event.data.pr" }],
        },
        async ({ inbox }) => {
          const message = await inbox.next();

          if (message?.is(reviewed)) {
            expectTypeOf(message.data.pr).toBeString();
          }
        },
      );
    });
  });

  test("inbox: an event type with no schema has data of Record<string, any>", () => {
    typesOnly(() => {
      agents.agent(
        { id: "inbox-4", triggers: [eventType("plain/event")] },
        async ({ inbox }) => {
          const message = await inbox.next();

          if (message?.is(eventType("plain/event"))) {
            // The one allowed `any`, as in core.
            expectTypeOf(message.data).toEqualTypeOf<Record<string, any>>();
          }
        },
      );
    });
  });
});
