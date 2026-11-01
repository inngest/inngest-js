/**
 * @module
 * The keys of the GitHub panel.
 */
import type { KeyDef } from "../keys.ts";

export const githubKeys: KeyDef[] = [
  {
    id: "github",
    label: "GitHub pane",
    group: "Panes",
    inField: ["Alt+Shift+G"],
    outside: ["6", "g h"],
  },
  {
    id: "githubComment",
    label: "Comment on the latest issue or pull request",
    group: "GitHub",
    inField: ["Alt+Shift+A"],
    outside: ["a"],
  },
  {
    id: "githubApprove",
    label: "Approve the latest pull request",
    group: "GitHub",
    inField: ["Alt+Shift+I"],
    outside: ["v"],
  },
  {
    id: "githubPull",
    label: "Open a pull request",
    group: "GitHub",
    inField: ["Alt+Shift+B"],
    outside: ["p"],
  },
  {
    id: "githubIssue",
    label: "Open an issue",
    group: "GitHub",
    inField: ["Alt+Shift+J"],
    outside: ["o"],
  },
];
