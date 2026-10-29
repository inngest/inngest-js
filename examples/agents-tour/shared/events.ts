/**
 * @module
 * The exact event each start of a page sends. The Run button, the server and
 * the lesson text's event block all read it from here.
 */
import type { Start } from "./types.ts";

export const eventOfMessage = (
  agent: string,
  thread: string,
  content: string,
) => {
  return {
    name: "agent/message",
    data: { agent: `tour/${agent}`, thread, kind: "user", content },
  };
};

export const eventOfStart = (start: Start) => {
  if ("event" in start) {
    return start.event;
  }

  if ("slack" in start) {
    return { name: "slack/message", data: start.slack };
  }

  return eventOfMessage(start.agent, start.thread, start.message);
};
