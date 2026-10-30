import { agents } from "./setup";

export const echo = agents.agent({ id: "echo" }, async ({ inbox }) => {
  const first = await inbox.next();
  const second = await inbox.next();

  const text = (message: typeof first) => {
    return message?.name === "agent/message" ? message.data.text : undefined;
  };

  return `First: ${text(first)}. Second: ${text(second)}`;
});
