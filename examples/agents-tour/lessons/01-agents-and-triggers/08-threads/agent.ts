import { agents } from "./setup";

export const chat = agents.agent({ id: "chat" }, async ({ inbox }) => {
  const first = await inbox.next();
  const second = await inbox.next();

  return `${first?.content} then ${second?.content}`;
});
