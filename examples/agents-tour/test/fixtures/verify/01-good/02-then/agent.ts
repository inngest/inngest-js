import { agents } from "./setup";

export const echo = agents.agent({ id: "echo" }, async ({ inbox }) => {
  const first = await inbox.next();
  const second = await inbox.next();

  if (first?.name === "agent/message" && second?.name === "agent/message") {
    return `${first.data.text} ${second.data.text}`;
  }
});
