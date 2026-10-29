import { slack } from "inngest/experimental/agents";
import { agents, slackApi } from "./setup";

export const helper = agents.agent(
  {
    id: "helper",
    on: slack.thread({ in: ["C02ENG"] }),
    channels: ({ event }) => {
      return {
        main: slack.channel(event, { in: ["C02ENG"], apiUrl: slackApi }),
      };
    },
  },
  async ({ inbox, report }) => {
    const message = await inbox.next();

    await report(`You said: ${message?.content}`);

    return message?.content;
  },
);
