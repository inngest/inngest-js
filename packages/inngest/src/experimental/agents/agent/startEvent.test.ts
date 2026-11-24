/**
 * @module
 * Tests for the turn a run's start event is.
 */
import { agentMessageEvent } from "../threads/thread.ts";
import { emptySnapshot, threadForward } from "../threads/threadProtocol.ts";
import { startInflight } from "./startEvent.ts";

describe("the turn a forward starts", () => {
  const forward = (events: { name: string; data: unknown }[]) => {
    return {
      id: "fwd",
      name: threadForward.name,
      data: {
        agent: "app/agent",
        thread: "t",
        gen: 1,
        events: events.map((event, at) => {
          return { seq: at + 1, id: `e${at + 1}`, ts: 0, ...event };
        }),
        state: emptySnapshot(),
      },
    };
  };

  test("is the newest entry it carries, never the forward", () => {
    const turn = startInflight(
      undefined,
      forward([
        { name: agentMessageEvent, data: { content: "first" } },
        { name: agentMessageEvent, data: { content: "second" } },
      ]),
    );

    expect(turn).toEqual({ content: "second", id: "e2" });
  });

  test("carries none of the thread's state", () => {
    const turn = startInflight(
      undefined,
      forward([{ name: "chat/message", data: { text: "hi" } }]),
    );

    expect(JSON.stringify(turn)).not.toContain("state");
    expect(turn).toEqual({
      event: { id: "e1", name: "chat/message", data: { text: "hi" } },
    });
  });

  test("is nothing when the forward carries no entry", () => {
    expect(startInflight(undefined, forward([]))).toBeUndefined();
  });
});
