import { agents } from "./setup";

export const greeter = agents.agent(
  { id: "greeter", on: { event: "tour/greet", thread: "event.data.name" } },
  async ({ inbox }) => {
    const message = await inbox.next();

    if (message?.name === "tour/greet") {
      return `Hello, ${message.data.name}!`;
    }
  },
);

export const other = agents.agent(
  { id: "other", on: { event: "tour/other", thread: "event.data.name" } },
  async ({ inbox }) => {
    await inbox.next();

    return "other";
  },
);
