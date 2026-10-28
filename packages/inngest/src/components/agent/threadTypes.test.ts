/**
 * @module
 * Type tests: a thread message is a union by `kind`, and an agent's
 * `requests` config types `request()`, the `"request"` payload and `reply()`.
 */
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { staticSchema } from "../triggers/triggers.ts";
import { createAgents } from "./agents.ts";
import { getThread, type ThreadMessage } from "./thread.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);

const asks = {
  request: z.object({ question: z.string() }),
  reply: z.object({ answer: z.string() }),
};

describe("thread message kinds", () => {
  // Never called: the test is the types.
  const types = (message: ThreadMessage) => {
    if (message.kind === "request") {
      expectTypeOf(message.payload).toBeUnknown();
      expectTypeOf(message.replyTo).toBeString();
      expectTypeOf(message.from).toEqualTypeOf<string | undefined>();
    }

    if (message.kind === "stop") {
      expectTypeOf(message.when).toEqualTypeOf<"nextTurn">();
    }

    if (message.kind === "steer") {
      expectTypeOf(message.content).toBeString();
    }

    if (message.kind === "user") {
      expectTypeOf(message.content).toEqualTypeOf<string | undefined>();

      // @ts-expect-error only a request has a payload
      message.payload;

      // @ts-expect-error only a request has a reply signal
      message.replyTo;

      // @ts-expect-error only a stop has a when
      message.when;
    }

    // Any message can be read for its text.
    expectTypeOf(message.content).toEqualTypeOf<string | undefined>();
  };

  test("each kind has its own fields", () => {
    expect(types).toBeTypeOf("function");
  });

  test("a message must carry its kind's required fields", () => {
    // @ts-expect-error a request needs a payload and a reply signal
    const request: ThreadMessage = { agent: "a", thread: "t", kind: "request" };

    // @ts-expect-error a stop needs a when
    const stop: ThreadMessage = { agent: "a", thread: "t", kind: "stop" };

    expect([request, stop]).toHaveLength(2);
  });
});

describe("requests", () => {
  const reviewer = agents.agent(
    {
      id: "reviewer",
      on: { event: "x/y", thread: "event.data.id" },
      requests: asks,
    },
    async ({ inbox, thread }) => {
      const message = await inbox.next();

      if (message?.data.kind === "request") {
        expectTypeOf(message.data.payload).toEqualTypeOf<{
          question: string;
        }>();

        await message.reply({ answer: "yes" });

        // @ts-expect-error the reply is an answer
        await message.reply({ nope: 1 });
      }

      expectTypeOf(thread.request).parameter(0).toEqualTypeOf<{
        question: string;
      }>();

      return undefined;
    },
  );

  // Never called: the test is the types.
  const types = async () => {
    const handle = reviewer.thread("t");

    const reply = await handle.request({ question: "ok?" });

    expectTypeOf(reply).toEqualTypeOf<{ answer: string } | null>();

    // @ts-expect-error the payload is a question
    await handle.request({ nope: 1 });

    // The reply can be narrowed, never widened to a different type.
    await handle.request<{ answer: "yes" }>({ question: "ok?" });

    // @ts-expect-error the reply is an answer
    await handle.request<{ other: number }>({ question: "ok?" });
  };

  test("the config types the payload, the reply and the handle", () => {
    expect(types).toBeTypeOf("function");
  });

  test("types alone are enough", () => {
    const typed = agents.agent(
      {
        id: "typed",
        on: { event: "x/y", thread: "event.data.id" },
        requests: {
          request: staticSchema<{ n: number }>(),
          reply: staticSchema<{ double: number }>(),
        },
      },
      async () => {
        return undefined;
      },
    );

    expectTypeOf(typed.thread("t").request<{ double: 2 }>).toBeFunction();
  });

  test("without requests everything is unknown", async () => {
    const plain = agents.agent(
      { id: "plain-asks", on: { event: "x/y", thread: "event.data.id" } },
      async ({ inbox }) => {
        const message = await inbox.next();

        if (message?.data.kind === "request") {
          expectTypeOf(message.data.payload).toBeUnknown();
        }

        await message?.reply({ anything: 1 });

        return undefined;
      },
    );

    const types = async () => {
      expectTypeOf(await plain.thread("t").request({ any: 1 })).toEqualTypeOf<
        unknown | null
      >();

      // The reply you expect can still be named.
      expectTypeOf(
        await plain.thread("t").request<{ a: number }>({ any: 1 }),
      ).toEqualTypeOf<{ a: number } | null>();

      // A handle made by address is as loose.
      await getThread(client, "app/plain-asks", "t").request("anything");
    };

    expect(types).toBeTypeOf("function");
  });

  test("getThread can be given the types of an agent it does not hold", () => {
    const types = async () => {
      const handle = getThread<{ n: number }, { double: number }>(
        client,
        "app/other",
        "t",
      );

      expectTypeOf(await handle.request({ n: 1 })).toEqualTypeOf<{
        double: number;
      } | null>();
    };

    expect(types).toBeTypeOf("function");
  });
});
