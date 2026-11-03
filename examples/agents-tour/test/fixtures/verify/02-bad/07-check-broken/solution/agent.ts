import { agents } from "./setup";

export const greeter = agents.agent({ id: "greeter" }, async ({ inbox }) => {
  const message = await inbox.next();

  if (message?.name === "agent/message") {
    return `Hello, ${message.data.content}!`;
  }
});
