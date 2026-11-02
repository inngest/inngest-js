/**
 * @module
 * The keys of sound: the speaker, the style menu, Doom's track and the peek.
 * Inside the style menu, the arrows, Enter, Esc and 1 to 5 belong to the menu.
 */
import { defineKeys } from "../keys.ts";

export const soundKeys = defineKeys([
  {
    id: "soundToggle",
    rank: 50,
    label: "Sound on or off",
    group: "Sound",
    inField: ["Alt+Shift+D"],
    outside: ["m"],
  },
  {
    id: "soundMenu",
    rank: 51,
    label: "Pick a sound style (1 to 5, then Enter)",
    group: "Sound",
    inField: ["Alt+Shift+X"],
    outside: ["M"],
  },
  {
    id: "soundTrack",
    rank: 52,
    label: "Doom: play the other track",
    group: "Sound",
    inField: ["Alt+Shift+0"],
    outside: ["V"],
  },
  {
    id: "soundPeek",
    rank: 53,
    label: "Doom: show the peeking face now (sound off)",
    group: "Sound",
    inField: ["Alt+Shift+3"],
    outside: ["E"],
  },
]);

declare module "../keys.ts" {
  interface KeyLists {
    sound: typeof soundKeys;
  }
}
