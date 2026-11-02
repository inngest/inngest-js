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
            // biome-ignore lint/suspicious/noExplicitAny: pins the one allowed any
            expectTypeOf(message.data).toEqualTypeOf<Record<string, any>>();
          }
        },
      );
    });
  });
});

describe("inbox: the four message types", () => {
  test("inbox: agent/question has an id, a text and a reply that takes text", () => {
    typesOnly(() => {
      agents.agent(
        { id: "inbox-q", triggers: [created] },
        async ({ inbox }) => {
          const message = await inbox.next();

          if (message?.name === "agent/question") {
            expectTypeOf(message.data.id).toBeString();
            expectTypeOf(message.data.text).toBeString();
            expectTypeOf<string>().toExtend<
              Parameters<typeof message.reply>[0]
            >();
            expectTypeOf(message.reply("answer")).resolves.toBeVoid();
          }
        },
      );
    });
  });

  test("inbox: agent/answer narrows by outcome", () => {
    typesOnly(() => {
      agents.agent(
        { id: "inbox-a", triggers: [created] },
        async ({ inbox }) => {
          const message = await inbox.next();

          if (message?.name === "agent/answer") {
            expectTypeOf(message.data.re).toBeString();

            if (message.data.outcome === "answered") {
              expectTypeOf(message.data.text).toBeString();
            } else {
              expectTypeOf(message.data.outcome).toEqualTypeOf<
                "refused" | "timed_out"
              >();
            }
          }
        },
      );
    });
  });

  test("inbox: agent/finished narrows by outcome", () => {
    typesOnly(() => {
      agents.agent(
        { id: "inbox-f", triggers: [created] },
        async ({ inbox }) => {
          const message = await inbox.next();

          if (message?.name === "agent/finished") {
            if (message.data.outcome === "failed") {
              expectTypeOf(message.data.error).toBeString();
            }

            if (message.data.outcome === "completed") {
              expectTypeOf(message.data).toHaveProperty("output");
            }
          }
        },
      );
    });
  });
});

test("inbox: the deleted reads and fields are gone", () => {
  typesOnly(() => {
    agents.agent({ id: "inbox-10", triggers: [created] }, async ({ inbox }) => {
      // @ts-expect-error putBack is deleted
      inbox.putBack;

      // @ts-expect-error current() is deleted
      inbox.current;

      // @ts-expect-error unread() is deleted
      inbox.unread;

      // @ts-expect-error listen() is deleted
      inbox.listen;

      const message = await inbox.next();

      // @ts-expect-error a message has no seq
      message?.seq;

      return null;
    });
  });
});

describe("inbox: who sent a message", () => {
  test("inbox: from is a handle for an agent and cannot be messaged for a function", () => {
    typesOnly(() => {
      agents.agent(
        { id: "inbox-from", triggers: [created] },
        async ({ inbox }) => {
          const message = await inbox.next();

          if (message?.name === "agent/message" && message.from) {
            const from = message.from;

            if (from.kind === "agent") {
              expectTypeOf(from.address).toBeString();
              expectTypeOf(from.key).toBeString();
              expectTypeOf(from.message).toBeFunction();
              expectTypeOf(from.ask).toBeFunction();
              expectTypeOf(from.stop).toBeFunction();
              // The sender's output is not known here.
              expectTypeOf(from.message("hi").result()).resolves.toBeUnknown();
            } else {
              expectTypeOf(from.id).toBeString();
              expectTypeOf(from.key).toBeString();
              expectTypeOf(from).not.toHaveProperty("message");
              expectTypeOf(from).not.toHaveProperty("ask");
              expectTypeOf(from).not.toHaveProperty("stop");
            }
          }
        },
      );
    });
  });
});
