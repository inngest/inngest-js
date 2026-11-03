import { agents } from "./setup";

export const hello = agents.agent({ id: "hello" }, async ({ event }) => {
  return `You said: ${event.data.content}`;
});
