import { agents } from "./setup";

export const greeter = agents.agent(
  {
    id: "greeter",
    on: {
      event: "tour/greet",
      thread: "event.data.name",
    },
  },
  async ({ inbox }) => {
    const message = await inbox.next();

    if (message?.name === "tour/greet") {
      return `Hello, ${message.data.name}!`;
    }

    return undefined;
  },
);
