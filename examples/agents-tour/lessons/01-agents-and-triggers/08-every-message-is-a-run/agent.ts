import { agents } from "./setup";

export const echo = agents.agent({ id: "echo" }, async ({ inbox }) => {
  const message = await inbox.next();

  const text =
    message?.name === "agent/message" ? message.data.text : undefined;

  return `Run for: ${text}`;
});
