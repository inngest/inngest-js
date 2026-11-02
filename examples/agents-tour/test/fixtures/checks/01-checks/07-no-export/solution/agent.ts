import { agents } from "./setup";

export const echo = agents.agent({ id: "echo" }, async ({ inbox }) => {
  const message = await inbox.next();

  if (message?.name === "agent/message") {
    return message.data.text;
  }
});
