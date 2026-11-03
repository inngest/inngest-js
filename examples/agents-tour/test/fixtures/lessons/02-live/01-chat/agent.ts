import { agents } from "./setup";

export const chat = agents.agent(
  { id: "chat", idle: "10m" },
  async ({ inbox }) => {
    await inbox.next();

    const second = await inbox.next();

    return second?.name;
  },
);
