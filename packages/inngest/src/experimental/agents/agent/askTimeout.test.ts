/**
 * @module
 * Tests for the function that ends a question nobody answered: after the
 * timeout it sends `agent/answer` with outcome `timed_out`, with the event ID
 * of a real answer so the first one wins, and an answer cancels it.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { askTimeoutFunction } from "./askTimeout.ts";
import { run } from "./test-helpers.ts";

describe("the ask timeout", () => {
  test("is cancelled by an answer to its question", () => {
    const fn = askTimeoutFunction(new Inngest({ id: testClientId }));

    expect(fn.opts.cancelOn).toEqual([
      { event: "agent/answer", if: "async.data.re == event.data.id" },
    ]);
  });

  test("sends a timed_out answer to the asker with the answer's event id", async () => {
    const client = new Inngest({ id: testClientId });
    const fn = askTimeoutFunction(client);
    const sent: { name: string; id?: string; data: Record<string, unknown> }[] =
      [];

    Object.defineProperty(client, "_send", {
      value: async (input: { payload: unknown }) => {
        for (const event of [input.payload].flat()) {
          sent.push(event as (typeof sent)[number]);
        }

        return { ids: [], status: 200 };
      },
    });

    await run(fn, {
      event: {
        name: "agent/ask.timeout",
        data: { id: "q1", agent: "app/asker", thread: "a1", timeout: "1h" },
      },
    });

    expect(sent).toMatchObject([
      {
        name: "agent/answer",
        id: "answer:q1",
        data: {
          agent: "app/asker",
          thread: "a1",
          re: "q1",
          outcome: "timed_out",
        },
      },
    ]);
  });
});
