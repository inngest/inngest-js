import { agents } from "./setup";

export const greeter = agents.agent(
  {
    id: "greeter",
    on: {
      event: "tour/greet",
      thread: "event.data.name",
      message: (event) => {
        return `Hello, ${event.data.name}!`;
      },
    },
  },
  async ({ inbox }) => {
    const message = await inbox.next();

    return message?.content;
  },
);
