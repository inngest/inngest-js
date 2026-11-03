/**
 * @module
 * The keys of the page itself: code, pages, panes, trace and focus.
 */
import { defineKeys } from "../keys.ts";

export const coreKeys = defineKeys([
  {
    id: "run",
    rank: 1,
    label: "Run",
    group: "Code",
    inField: ["Mod+Enter"],
    outside: ["r", "Mod+Enter"],
  },
  {
    id: "kill",
    rank: 2,
    label: "Kill live runs",
    group: "Code",
    inField: ["Alt+Shift+K"],
    outside: ["x"],
  },
  {
    id: "reset",
    rank: 3,
    label: "Reset the code and the runs",
    group: "Code",
    inField: ["Alt+Shift+R"],
    outside: ["R"],
  },
  {
    id: "format",
    rank: 4,
    label: "Format",
    group: "Code",
    inField: ["Alt+Shift+F"],
    outside: ["f"],
  },
  {
    id: "next",
    rank: 5,
    label: "Next page",
    group: "Pages",
    inField: ["Alt+]", "Alt+PageDown"],
    outside: ["ArrowRight", "j"],
  },
  {
    id: "prev",
    rank: 6,
    label: "Previous page",
    group: "Pages",
    inField: ["Alt+[", "Alt+PageUp"],
    outside: ["ArrowLeft", "k"],
  },
  {
    id: "contents",
    rank: 7,
    label: "Focus the left nav",
    group: "Pages",
    inField: ["Alt+Shift+C"],
    outside: ["g c"],
  },
  {
    id: "search",
    rank: 8,
    label: "Search pages",
    group: "Pages",
    inField: ["Mod+K"],
    outside: [],
  },
  {
    id: "text",
    rank: 10,
    label: "Lesson text",
    group: "Panes",
    inField: ["Alt+Shift+1"],
    outside: ["1"],
  },
  {
    id: "trace",
    rank: 12,
    label: "Trace",
    group: "Panes",
    inField: ["Alt+Shift+T"],
    outside: ["4", "g t"],
  },
  {
    id: "file",
    rank: 30,
    label: "Switch between the code files",
    group: "Code",
    inField: ["Alt+Shift+L"],
    outside: ["l"],
  },
  {
    id: "undo",
    rank: 32,
    label: "Undo reset",
    group: "Code",
    inField: ["Alt+Shift+U"],
    outside: ["u"],
  },
  {
    id: "editor",
    rank: 33,
    label: "Leave or return to the editor",
    group: "Focus",
    inField: ["Alt+Shift+E"],
    outside: ["e"],
    note: "Esc also leaves when no editor widget is open",
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    core: typeof coreKeys;
  }
}
