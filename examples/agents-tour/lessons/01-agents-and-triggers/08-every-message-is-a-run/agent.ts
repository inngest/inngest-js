import { agents } from "./setup";

export const echo = agents.agent({ id: "echo" }, async ({ inbox }) => {
  const message = await inbox.next();

  return `Run for: ${message?.content}`;
});
