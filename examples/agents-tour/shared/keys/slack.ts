/**
 * @module
 * The keys of the Slack panel.
 */
import type { KeyDef } from "../keys.ts";

export const slackKeys: KeyDef[] = [
  {
    id: "slack",
    label: "Slack pane",
    group: "Panes",
    inField: ["Alt+Shift+S"],
    outside: ["5", "g s"],
  },
  {
    id: "slackCompose",
    label: "Mention the bot in Slack",
    group: "Slack",
    inField: ["Alt+Shift+Q"],
    outside: ["i"],
  },
  {
    id: "slackNew",
    label: "Reply in the Slack thread",
    group: "Slack",
    inField: ["Alt+Shift+W"],
    outside: ["w"],
  },
  {
    id: "approve",
    label: "Click Approve in Slack",
    group: "Slack",
    inField: ["Alt+Shift+Y"],
    outside: ["y"],
  },
  {
    id: "deny",
    label: "Click Deny in Slack",
    group: "Slack",
    inField: ["Alt+Shift+N"],
    outside: ["n"],
  },
];
