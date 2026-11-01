/**
 * @module
 * The keys of the Messages panel.
 */
import { defineKeys } from "../keys.ts";

export const messagesKeys = defineKeys([
  {
    id: "message",
    rank: 11,
    label: "Play pane (message box)",
    group: "Panes",
    inField: ["Alt+Shift+M"],
    outside: ["3", "g m"],
  },
  {
    id: "sendEvent",
    rank: 16,
    panels: ["message", "events"],
    label: "Send (a message or an event)",
    group: "Panes",
    inField: ["Alt+Shift+Enter"],
    outside: ["s"],
  },
  {
    id: "sendOther",
    rank: 17,
    panels: ["message"],
    label: "Send to the second thread",
    group: "Panes",
    inField: ["Alt+Shift+9"],
    outside: ["9"],
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    messages: typeof messagesKeys;
  }
}
