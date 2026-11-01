import { github } from "inngest/experimental/agents";
import { agents, githubOptions } from "./setup";

export const triage = agents.agent(
  {
    id: "triage",
    on: { event: "github/issues.opened", thread: "string(event.data.number)" },
    channels: ({ event }) => {
      return { main: github.channel(event, githubOptions) };
    },
  },
  async ({ inbox, report }) => {
    const message = await inbox.next();

    if (message?.name === "github/issues.opened") {
      await report(`Thanks, I will look at: ${message.data.title}`);
    }
  },
);
