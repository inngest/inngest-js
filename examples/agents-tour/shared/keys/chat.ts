/**
 * @module
 * The keys of the chat: focusing the box and sending what is in it.
 */
import { defineKeys } from "../keys.ts";

export const chatKeys = defineKeys([
  {
    id: "chat",
    rank: 11,
    label: "Chat box",
    group: "Panes",
    inField: ["Alt+Shift+M"],
    outside: ["3", "g m"],
  },
  {
    id: "chatSend",
    rank: 16,
    label: "Send what is in the chat box",
    group: "Panes",
    inField: ["Alt+Shift+Enter"],
    outside: ["s"],
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    chat: typeof chatKeys;
  }
}
