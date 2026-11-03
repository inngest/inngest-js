import { agents } from "./setup";

export const answer = agents.agent({ id: "answer" }, async ({ inbox }) => {
  const message = await inbox.next();

  if (message?.name === "agent/message") {
    return `Hello, ${message.data.content}!`;
  }
});
