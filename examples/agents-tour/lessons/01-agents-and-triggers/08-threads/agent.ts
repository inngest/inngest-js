import { agents } from "./setup";

export const chat = agents.agent({ id: "chat" }, async ({ inbox }) => {
  const first = await inbox.next();
  const second = await inbox.next();

  if (first?.name === "agent/message" && second?.name === "agent/message") {
    return `${first.data.text} then ${second.data.text}`;
  }
});
