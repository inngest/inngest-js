/**
 * @module
 * Type tests: an inbox message is a union by event `name`.
 */
import type { AgentMessage } from "../agent/types.ts";

describe("thread message events", () => {
  // Never called: the test is the types.
  const types = (message: AgentMessage) => {
    switch (message.name) {
      case "agent/message":
        expectTypeOf(message.data.thread).toBeString();

        // @ts-expect-error a message has no stop condition
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
