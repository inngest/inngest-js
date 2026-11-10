/**
 * @module
 * The keys of the Events panel.
 */
import { defineKeys } from "../keys.ts";

export const eventsKeys = defineKeys([
  {
    id: "events",
    rank: 15,
    label: "Event sender pane",
    group: "Panes",
    inField: ["Alt+Shift+V"],
    outside: ["7", "g v"],
  },
  {
    id: "sendEvent",
    rank: 17,
    panels: ["events"],
    label: "Send an event",
    group: "Panes",
    inField: ["Alt+Shift+9"],
    outside: ["9"],
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    events: typeof eventsKeys;
  }
}
