/**
 * @module
 * The keys of the GitHub panel.
 */
import { defineKeys } from "../keys.ts";

export const githubKeys = defineKeys([
  {
    id: "github",
    rank: 14,
    label: "GitHub pane",
    group: "Panes",
    inField: ["Alt+Shift+G"],
    outside: ["6", "g h"],
  },
  {
    id: "githubComment",
    rank: 22,
    panels: ["github"],
    label: "Comment on the latest issue or pull request",
    group: "GitHub",
    inField: ["Alt+Shift+A"],
    outside: ["a"],
  },
  {
    id: "githubApprove",
    rank: 23,
    panels: ["github"],
    label: "Approve the latest pull request",
    group: "GitHub",
    inField: ["Alt+Shift+I"],
    outside: ["v"],
  },
  {
    id: "githubPull",
    rank: 24,
    panels: ["github"],
    label: "Open a pull request",
    group: "GitHub",
    inField: ["Alt+Shift+B"],
    outside: ["p"],
  },
  {
    id: "githubIssue",
    rank: 25,
    panels: ["github"],
    label: "Open an issue",
    group: "GitHub",
    inField: ["Alt+Shift+J"],
    outside: ["o"],
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    github: typeof githubKeys;
  }
}
