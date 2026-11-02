import { agents } from "./setup";

export const pair = agents.agent(
  { id: "pair", on: { event: "tour/pair", thread: "event.data.name" } },
  async ({ inbox }) => {
    const first = await inbox.next();
    const second = await inbox.next();

    if (first?.name === "tour/pair" && second?.name === "tour/pair") {
      return `${first.data.n}+${second.data.n}`;
    }
  },
);
