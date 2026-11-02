/**
 * @module
 * The keys of an exercise page: show the hint, Check, Show a solution.
 */
import { defineKeys } from "../keys.ts";

export const exerciseKeys = defineKeys([
  {
    id: "check",
    rank: 8,
    label: "Check",
    group: "Exercise",
    inField: ["Alt+Shift+D"],
    outside: ["c"],
  },
  {
    id: "hint",
    rank: 9,
    label: "Hint",
    group: "Exercise",
    inField: ["Alt+Shift+X"],
    outside: ["t"],
  },
  {
    id: "solution",
    rank: 10,
    label: "Show a solution",
    group: "Exercise",
    inField: ["Alt+Shift+Z"],
    outside: ["z"],
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    exercise: typeof exerciseKeys;
  }
}
