import { agents } from "./setup";

export const echo = agents.agent({ id: "echo" }, async ({ inbox }) => {
  const message = await inbox.next();

  console.log(`Got: ${message?.content}`);

  return `You said: ${message?.content}`;
});
