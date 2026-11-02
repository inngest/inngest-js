/**
 * @module
 * The keys of progress: the left nav, the end of a module, the deeper
 * pages and the concept collection.
 */
import { defineKeys } from "../keys.ts";

export const progressKeys = defineKeys([
  {
    id: "navToggle",
    rank: 40,
    label: "Collapse or open the left nav",
    group: "Pages",
    inField: ["Alt+Shift+2"],
    outside: ["b"],
  },
  {
    id: "nextModule",
    rank: 41,
    label: "Next module (at the end of a module)",
    group: "Pages",
    inField: ["Alt+Shift+4"],
    outside: ["N"],
  },
  {
    id: "goDeeper",
    rank: 42,
    label: "Go deeper (at the end of a module)",
    group: "Pages",
    inField: ["Alt+Shift+5"],
    outside: ["D"],
  },
  {
    id: "deeperList",
    rank: 43,
    label: "Deeper pages waiting",
    group: "Pages",
    inField: ["Alt+Shift+6"],
    outside: ["g d"],
  },
  {
    id: "concepts",
    rank: 44,
    label: "Concepts collected",
    group: "Pages",
    inField: ["Alt+Shift+O"],
    outside: ["g o"],
  },
  {
    id: "dismiss",
    rank: 46,
    label: "Close the nav overlay or the module-done banner",
    group: "Pages",
    inField: [],
    outside: ["Escape"],
  },
  {
    id: "resetProgress",
    rank: 45,
    label: "Reset progress",
    group: "Pages",
    inField: ["Alt+Shift+Z"],
    outside: ["Z"],
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    progress: typeof progressKeys;
  }
}
