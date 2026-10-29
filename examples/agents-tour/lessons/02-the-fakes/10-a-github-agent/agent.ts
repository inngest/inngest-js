import { github } from "inngest/experimental/agents";
import { agents, githubApi } from "./setup";

const repos = ["acme/web"];

export const triage = agents.agent(
  {
    id: "triage",
    on: github.thread({ repos }),
    channels: ({ event }) => {
      return {
        main: github.channel(event, {
          repos,
          apiUrl: githubApi,
          token: "tour",
        }),
      };
    },
  },
  async ({ inbox, report }) => {
    const message = await inbox.next();

    await report("Thanks, I will take a look.");

    return message?.content;
  },
);
