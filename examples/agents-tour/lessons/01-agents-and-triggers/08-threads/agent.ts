import { agents } from "./setup";

export const chat = agents.agent({ id: "chat" }, async ({ inbox }) => {
  const first = await inbox.next();
  const second = await inbox.next();

  const text = (message: typeof first) => {
    return message?.name === "agent/message" ? message.data.text : undefined;
  };

  return `${text(first)} then ${text(second)}`;
});
