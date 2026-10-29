/**
 * @module
 * The exact event each start of a page sends. The Run button, the server and
 * the read-only `run.ts` tab all read it from here.
 */
import type { Start } from "./types.ts";

export const eventOfMessage = (
  agent: string,
  thread: string,
  content: string,
) => {
  return {
    name: "agent/message",
    data: { agent: `tour/${agent}`, thread, text: content },
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

/**
 * The text of `run.ts`: a comment and the event as a typed constant.
 */
export const runFileOf = (starts: Start[]) => {
  const events = starts.map(eventOfStart);
  const single = events.length === 1;

  return [
    "// This is the event sent when you press Run.",
    "// It starts the run and is the inbox's first message.",
    'import type { EventPayload } from "inngest";',
    "",
    single
      ? `export const event: EventPayload = ${JSON.stringify(events[0], null, 2)};`
      : `export const events: EventPayload[] = ${JSON.stringify(events, null, 2)};`,
    "",
  ].join("\n");
};
