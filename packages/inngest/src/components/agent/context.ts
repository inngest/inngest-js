/**
 * @module
 * Keeps the conversation `agent.loop()` sends to the model within a size
 * budget, on the loop's neutral messages so no provider format is involved.
 */
import type { AgentMessage } from "./loop.ts";

/**
 * The messages at the end of the conversation that are always sent whole: the
 * last few replies and their results are what the model is working from.
 */
const keepRecent = 6;

/**
 * How much of an old tool result is kept once it is shortened.
 */
const keptOfOldResult = 200;

const sizeOf = (message: AgentMessage): number => {
  if (message.role === "tool") {
    return message.results.reduce((total, result) => {
      return total + result.content.length;
    }, 0);
  }

  return typeof message.content === "string"
    ? message.content.length
    : JSON.stringify(message.content).length;
};

/**
 * Returns `messages` with old tool results shortened, oldest first, until the
 * conversation fits in `maxChars` or only the recent messages are left. No
 * message is dropped, so every tool call keeps its result.
 */
export const clipContext = (
  messages: AgentMessage[],
  maxChars: number,
): AgentMessage[] => {
  let total = messages.reduce((sum, message) => {
    return sum + sizeOf(message);
  }, 0);

  if (total <= maxChars) {
    return messages;
  }

  return messages.map((message, index) => {
    if (
      message.role !== "tool" ||
      total <= maxChars ||
      index >= messages.length - keepRecent
    ) {
      return message;
    }

    const before = sizeOf(message);
    const clipped: AgentMessage = {
      role: "tool",
      results: message.results.map((result) => {
        const dropped = result.content.length - keptOfOldResult;

        return dropped > 0
          ? {
              ...result,
              content: `${result.content.slice(0, keptOfOldResult)}\n... clipped ${dropped} characters ...`,
            }
          : result;
      }),
    };

    total -= before - sizeOf(clipped);

    return clipped;
  });
};
