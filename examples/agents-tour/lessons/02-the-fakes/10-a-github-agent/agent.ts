import { github } from "inngest/experimental/agents";
import { agents, githubApi } from "./setup";

const repos = ["acme/web"];

export const triage = agents.agent(
  {
    id: "triage",
    on: {
      event: "github/issues.opened",
      if: 'event.data.owner == "acme" && event.data.repo == "web"',
      thread:
        '"github:" + event.data.owner + "/" + event.data.repo + "#" + string(int(event.data.number))',
    },
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

    return message?.name === "github/issues.opened"
      ? String(message.data.body)
      : undefined;
  },
);
