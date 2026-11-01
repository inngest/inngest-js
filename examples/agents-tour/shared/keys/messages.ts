/**
 * @module
 * The keys of the Messages panel.
 */
import type { KeyDef } from "../keys.ts";

export const messagesKeys: KeyDef[] = [
  {
    id: "message",
    label: "Play pane (message box)",
    group: "Panes",
    inField: ["Alt+Shift+M"],
    outside: ["3", "g m"],
  },
  {
    id: "sendEvent",
    label: "Send (a message or an event)",
    group: "Panes",
    inField: ["Alt+Shift+Enter"],
    outside: ["s"],
  },
  {
    id: "sendOther",
    label: "Send to the second thread",
    group: "Panes",
    inField: ["Alt+Shift+9"],
    outside: ["9"],
  },
];
