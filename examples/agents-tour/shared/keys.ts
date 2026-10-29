/**
 * @module
 * The one key table. The editor commands, the window handler, the `<kbd>`
 * hints and the cheat sheet are all made from it, so they cannot drift.
 *
 * A combo is written `Mod+Enter`, `Alt+Shift+K` or `Alt+]`. `Mod` is Ctrl on
 * Windows and Linux and Cmd on macOS. Letters and symbols in a combo with a
 * modifier are matched by physical key, so Alt does not change them on macOS.
 * A plain `outside` binding is a single key (`r`, `?`, `ArrowRight`) that
 * works only when focus is not in a text field; `g c` is a sequence.
 */

export type ActionId =
  | "run"
  | "kill"
  | "reset"
  | "format"
  | "next"
  | "prev"
  | "cheat"
  | "contents"
  | "search"
  | "output"
  | "trace"
  | "slack"
  | "github"
  | "events"
  | "message"
  | "everything"
  | "file"
  | "slackCompose"
  | "slackNew"
  | "slackChannel"
  | "slackReact"
  | "approve"
  | "deny"
  | "githubIssue"
  | "githubPull"
  | "sendEvent"
  | "rowDown"
  | "rowUp"
  | "rowOpen"
  | "editor"
  | "undo"
  | "theme";

export interface KeyDef {
  id: ActionId;
  label: string;
  group: "Code" | "Pages" | "Panels" | "Slack" | "GitHub" | "Trace" | "Focus";
  // Bindings that work while the editor or another text field has focus.
  inField: string[];
  // Bindings that work when focus is not in a text field.
  outside: string[];
  note?: string;
  // Handled by the panel that owns it, not by the window.
  local?: boolean;
}

export const keys: KeyDef[] = [
  {
    id: "run",
    label: "Run",
    group: "Code",
    inField: ["Mod+Enter"],
    outside: ["r", "Mod+Enter"],
  },
  {
    id: "kill",
    label: "Kill live runs",
    group: "Code",
    inField: ["Alt+Shift+K"],
    outside: ["x"],
  },
  {
    id: "reset",
    label: "Reset the code and the runs",
    group: "Code",
    inField: ["Alt+Shift+R"],
    outside: ["R"],
  },
  {
    id: "format",
    label: "Format",
    group: "Code",
    inField: ["Alt+Shift+F"],
    outside: ["f"],
  },
  {
    id: "next",
    label: "Next page",
    group: "Pages",
    inField: ["Alt+]", "Alt+PageDown"],
    outside: ["ArrowRight", "j"],
  },
  {
    id: "prev",
    label: "Previous page",
    group: "Pages",
    inField: ["Alt+[", "Alt+PageUp"],
    outside: ["ArrowLeft", "k"],
  },
  {
    id: "contents",
    label: "Contents",
    group: "Pages",
    inField: ["Alt+Shift+C"],
    outside: ["g c"],
  },
  {
    id: "search",
    label: "Search pages",
    group: "Pages",
    inField: ["Alt+Shift+P"],
    outside: ["/"],
  },
  {
    id: "cheat",
    label: "This cheat sheet",
    group: "Pages",
    inField: ["Alt+/"],
    outside: ["?"],
  },
  {
    id: "output",
    label: "Output panel",
    group: "Panels",
    inField: ["Alt+Shift+O"],
    outside: ["1", "g o"],
  },
  {
    id: "trace",
    label: "Trace panel",
    group: "Panels",
    inField: ["Alt+Shift+T"],
    outside: ["2", "g t"],
  },
  {
    id: "slack",
    label: "Slack panel",
    group: "Panels",
    inField: ["Alt+Shift+S"],
    outside: ["3", "g s"],
  },
  {
    id: "github",
    label: "GitHub panel",
    group: "Panels",
    inField: ["Alt+Shift+G"],
    outside: ["4", "g h"],
  },
  {
    id: "events",
    label: "Event sender",
    group: "Panels",
    inField: ["Alt+Shift+V"],
    outside: ["5", "g e"],
  },
  {
    id: "message",
    label: "Message box",
    group: "Panels",
    inField: ["Alt+Shift+M"],
    outside: ["m", "g m"],
  },
  {
    id: "file",
    label: "Switch between the code files",
    group: "Code",
    inField: ["Alt+Shift+L"],
    outside: ["l"],
  },
  {
    id: "slackCompose",
    label: "Write in Slack",
    group: "Slack",
    inField: ["Alt+Shift+Q"],
    outside: ["i"],
  },
  {
    id: "slackChannel",
    label: "Switch Slack channel",
    group: "Slack",
    inField: ["Alt+Shift+X"],
    outside: ["c"],
  },
  {
    id: "slackNew",
    label: "Start a new Slack thread",
    group: "Slack",
    inField: ["Alt+Shift+W"],
    outside: ["w"],
  },
  {
    id: "slackReact",
    label: "React with eyes to the last message",
    group: "Slack",
    inField: ["Alt+Shift+Z"],
    outside: ["z"],
  },
  {
    id: "approve",
    label: "Click Approve in Slack",
    group: "Slack",
    inField: ["Alt+Shift+Y"],
    outside: ["y"],
  },
  {
    id: "deny",
    label: "Click Deny in Slack",
    group: "Slack",
    inField: ["Alt+Shift+N"],
    outside: ["n"],
  },
  {
    id: "githubPull",
    label: "Open a pull request",
    group: "GitHub",
    inField: ["Alt+Shift+B"],
    outside: ["p"],
  },
  {
    id: "githubIssue",
    label: "Open an issue",
    group: "GitHub",
    inField: ["Alt+Shift+J"],
    outside: ["o"],
  },
  {
    id: "rowDown",
    label: "Next trace row",
    group: "Trace",
    inField: [],
    outside: ["ArrowDown"],
    local: true,
  },
  {
    id: "rowUp",
    label: "Previous trace row",
    group: "Trace",
    inField: [],
    outside: ["ArrowUp"],
    local: true,
  },
  {
    id: "rowOpen",
    label: "Open a trace row or its hidden steps",
    group: "Trace",
    inField: [],
    outside: ["Enter"],
    local: true,
  },
  {
    id: "sendEvent",
    label: "Send the event",
    group: "Panels",
    inField: ["Alt+Shift+Enter"],
    outside: ["s"],
  },
  {
    id: "everything",
    label: "Show every trace step",
    group: "Panels",
    inField: ["Alt+Shift+H"],
    outside: ["h"],
  },
  {
    id: "undo",
    label: "Undo reset",
    group: "Code",
    inField: ["Alt+Shift+U"],
    outside: ["u"],
  },
  {
    id: "theme",
    label: "Switch light, dark and system theme",
    group: "Focus",
    inField: ["Alt+Shift+D"],
    outside: ["d"],
  },
  {
    id: "editor",
    label: "Leave or return to the editor",
    group: "Focus",
    inField: ["Alt+Shift+E"],
    outside: ["e"],
    note: "Esc also leaves when no editor widget is open",
  },
];

export const monacoOnly = [
  {
    label: "Make Tab move focus instead of indenting",
    combo: "Ctrl+M (Ctrl+Shift+M on macOS)",
  },
];

export interface Combo {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  // A physical key code for combos with a modifier, an `event.key` otherwise.
  key: string;
}

const codeOf = (key: string) => {
  if (/^[a-z]$/i.test(key)) {
    return `Key${key.toUpperCase()}`;
  }

  if (/^\d$/.test(key)) {
    return `Digit${key}`;
  }

  const symbols: Record<string, string> = {
    "]": "BracketRight",
    "[": "BracketLeft",
    "/": "Slash",
  };

  return symbols[key] ?? key;
};

export const parseCombo = (spec: string): Combo => {
  const parts = spec.split("+");
  const key = parts.pop() ?? "";
  const mod = parts.includes("Mod");
  const alt = parts.includes("Alt");
  const shift = parts.includes("Shift");
  const physical = mod || alt;

  return { mod, alt, shift, key: physical ? codeOf(key) : key };
};

/**
 * The parts of a `KeyboardEvent` that matching reads.
 */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether a keyboard event is this combo. `isMac` decides what `Mod` means.
 */
export const matches = (event: KeyLike, spec: string, isMac: boolean) => {
  const combo = parseCombo(spec);
  const modDown = isMac ? event.metaKey : event.ctrlKey;
  const physical = combo.mod || combo.alt;

  if (combo.mod !== modDown || combo.alt !== event.altKey) {
    return false;
  }

  if (!isMac && !combo.mod && event.ctrlKey) {
    return false;
  }

  if (isMac && !combo.mod && event.metaKey) {
    return false;
  }

  if (physical) {
    return combo.shift === event.shiftKey && event.code === combo.key;
  }

  // Single keys: a capital letter is the key with Shift, others ignore it.
  return event.key === combo.key;
};

const glyphs: Record<string, [string, string]> = {
  Mod: ["Ctrl", "⌘"],
  Alt: ["Alt", "⌥"],
  Shift: ["Shift", "⇧"],
  Enter: ["Enter", "↵"],
  ArrowRight: ["→", "→"],
  ArrowLeft: ["←", "←"],
  PageDown: ["PgDn", "PgDn"],
  PageUp: ["PgUp", "PgUp"],
};

/**
 * The text of a hint, such as `Ctrl+Enter` or `⌘↵`.
 */
export const hintOf = (spec: string, isMac: boolean) => {
  if (spec.includes(" ")) {
    return spec;
  }

  if (/^[A-Z]$/.test(spec)) {
    return isMac ? `\u21e7${spec}` : `Shift+${spec}`;
  }

  const parts = spec.split("+").map((part) => {
    const glyph = glyphs[part];

    return glyph
      ? glyph[isMac ? 1 : 0]
      : part.length === 1
        ? part.toUpperCase()
        : part;
  });

  return parts.join(isMac ? "" : "+");
};

export const keyOf = (id: ActionId) => {
  const def = keys.find((candidate) => {
    return candidate.id === id;
  });

  if (!def) {
    throw new Error(`No key for ${id}`);
  }

  return def;
};
