/**
 * @module
 * The keys of the Events panel.
 */
import type { KeyDef } from "../keys.ts";

export const eventsKeys: KeyDef[] = [
  {
    id: "events",
    label: "Event sender pane",
    group: "Panes",
    inField: ["Alt+Shift+V"],
    outside: ["7", "g v"],
  },
];
