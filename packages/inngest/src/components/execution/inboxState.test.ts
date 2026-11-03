/**
 * @module
 * Tests for reading an inbox's messages out of a run's state: a message is the
 * event plus the inbox it belongs to, and nothing else.
 */
import { inboxRead, inboxUnread, isInboxMessage } from "./inboxState.ts";

const message = (inbox: string, name: string) => {
  return { data: { data: { name }, "inngest/inbox": inbox } };
};

describe("reading an inbox from state", () => {
  const stack = ["open", "m1", "other", "m2", "m3"];
  const stepState = {
    open: { data: { pauses: [] } },
    m1: message("inbox", "a"),
    other: message("elsewhere", "a"),
    m2: message("inbox", "b"),
    m3: message("inbox", "a"),
  };

  test("a message has the event and its inbox, and no source list", () => {
    expect(isInboxMessage(stepState.m1.data)).toBe(true);
    expect(isInboxMessage({ data: 1 })).toBe(false);
    expect(isInboxMessage(null)).toBe(false);
  });

  test("unread is every message of the inbox after the ones taken", () => {
    expect(inboxUnread("inbox", 0, stack, stepState)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(inboxUnread("inbox", 2, stack, stepState)).toEqual(["m3"]);
  });

  test("unread can stop at a cut, itself included", () => {
    expect(inboxUnread("inbox", 1, stack, stepState, "m2")).toEqual(["m2"]);
    expect(inboxUnread("inbox", 0, stack, stepState, "")).toEqual([]);
  });

  test("a read finds the message after the ones taken, or the timeout's null", () => {
    expect(inboxRead("inbox", 1, "w", stack, stepState)).toMatchObject({
      found: "message",
      id: "m2",
      message: { name: "b" },
    });
    expect(inboxRead("inbox", 3, "w", stack, stepState)).toEqual({
      found: "nothing",
    });
    expect(
      inboxRead("inbox", 3, "w", [...stack, "w"], {
        ...stepState,
        w: { data: null },
      }),
    ).toEqual({ found: "timeout" });
  });
});
