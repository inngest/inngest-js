/**
 * @module
 * The one key of sound: swapping Doom's track, shown on Doom's status bar.
 * The speaker and its style menu are mouse only, so they have no keys.
 */
import { defineKeys } from "../keys.ts";

export const soundKeys = defineKeys([
  {
    id: "soundTrack",
    rank: 52,
    label: "Doom: play the other track",
    group: "Sound",
    inField: ["Alt+Shift+0"],
    outside: ["V"],
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    sound: typeof soundKeys;
  }
}
