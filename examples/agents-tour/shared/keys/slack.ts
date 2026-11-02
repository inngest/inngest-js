/**
 * @module
 * The keys of the Slack panel.
 */
import { defineKeys } from "../keys.ts";

export const slackKeys = defineKeys([
  {
    id: "slack",
    rank: 13,
    label: "Slack pane",
    group: "Panes",
    inField: ["Alt+Shift+S"],
    outside: ["5", "g s"],
  },
  {
    id: "slackCompose",
    rank: 18,
    panels: ["slack"],
    label: "Mention the bot in Slack",
    group: "Slack",
    inField: ["Alt+Shift+Q"],
    outside: ["i"],
  },
  {
    id: "slackNew",
    rank: 19,
    panels: ["slack"],
    label: "Reply in the Slack thread",
    group: "Slack",
    inField: ["Alt+Shift+W"],
    outside: ["w"],
  },
  {
    id: "approve",
    rank: 20,
    panels: ["slack"],
    label: "Click Approve in Slack",
    group: "Slack",
    inField: ["Alt+Shift+Y"],
    outside: ["y"],
  },
  {
    id: "deny",
    rank: 21,
    panels: ["slack"],
    label: "Click Deny in Slack",
    group: "Slack",
    inField: ["Alt+Shift+N"],
    outside: ["n"],
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    slack: typeof slackKeys;
  }
}
