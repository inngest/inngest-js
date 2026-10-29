import { agents } from "./setup";

export const echo = agents.agent({ id: "echo" }, async ({ inbox }) => {
  const first = await inbox.next();
  const second = await inbox.next();

  return `First: ${first?.content}. Second: ${second?.content}`;
});
