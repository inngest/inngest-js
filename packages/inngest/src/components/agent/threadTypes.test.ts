/**
 * @module
 * Type tests: an inbox message is a union by event `name`, and an agent's
 * `requests` config types `request()`, the `agent/request` payload and
 * `reply()`.
 */
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { staticSchema } from "../triggers/triggers.ts";
import type { ThreadInboxMessage } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import type { ChannelMessage, ChannelStreamFinal } from "./channels.ts";
import { getThread, type ThreadRequests } from "./thread.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);

const asks = {
  request: z.object({ question: z.string() }),
  reply: z.object({ answer: z.string() }),
};

describe("thread message events", () => {
  // Never called: the test is the types.
  const types = (message: ThreadInboxMessage) => {
    switch (message.name) {
      case "agent/request":
        expectTypeOf(message.data.payload).toBeUnknown();
        expectTypeOf(message.data.replyTo).toBeString();
        expectTypeOf(message.data.from).toEqualTypeOf<string | undefined>();
        break;
      case "agent/stop":
        expectTypeOf(message.data.when).toEqualTypeOf<"nextTurn">();
        break;
      case "agent/steer":
      case "agent/message":
        expectTypeOf(message.data.text).toBeString();

        // @ts-expect-error only a request has a payload
        message.data.payload;

        // @ts-expect-error only a stop has a when
        message.data.when;
        break;
      default:
        break;
    }
  };

  test("each event has its own data", () => {
    expect(types).toBeTypeOf("function");
  });
});

describe("requests", () => {
  test("a schema that transforms its input is refused", () => {
    const transforming = z.string().transform(Number);

    expectTypeOf(transforming).not.toExtend<
      ThreadRequests<number, number>["request"]
    >();
    expectTypeOf(z.number()).toExtend<
      ThreadRequests<number, number>["request"]
    >();
  });

  const reviewer = agents.agent(
    {
      id: "reviewer",
      on: { event: "x/y", thread: "event.data.id" },
      requests: asks,
    },
    async ({ inbox, thread }) => {
      const message = await inbox.next();

      if (message?.name === "agent/request") {
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

    // Never called: the test is the types.
    const types = async () => {
      expectTypeOf(typed.thread("t").request)
        .parameter(0)
        .toEqualTypeOf<{ n: number }>();

      // @ts-expect-error the reply is a double
      await typed.thread("t").request<{ other: 1 }>({ n: 1 });
    };

    expect(types).toBeTypeOf("function");
  });

  test("without requests everything is unknown", async () => {
    const plain = agents.agent(
      { id: "plain-asks", on: { event: "x/y", thread: "event.data.id" } },
      async ({ inbox }) => {
        const message = await inbox.next();

        if (message?.name === "agent/request") {
          expectTypeOf(message.data.payload).toBeUnknown();
          await message.reply({ anything: 1 });
        }

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

describe("channel message blocks", () => {
  test("a message and a stream final carry blocks as unknown[]", () => {
    expectTypeOf<ChannelMessage["blocks"]>().toEqualTypeOf<
      unknown[] | undefined
    >();
    expectTypeOf<ChannelStreamFinal["blocks"]>().toEqualTypeOf<
      unknown[] | undefined
    >();
  });
});
