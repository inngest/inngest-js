import { slack } from "inngest/experimental/agents";
import { agents, slackOptions } from "./setup";

export const helper = agents.agent(
  {
    id: "helper",
    on: slack.thread({ in: ["C02ENG"] }),
    channels: ({ event }) => {
      return { main: slack.channel(event, slackOptions) };
    },
  },
  async ({ inbox, report }) => {
    const message = await inbox.next();
    const { text } = message?.data as { text: string };

    await report(`You said: ${text}`);
  },
);
