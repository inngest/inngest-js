/**
 * @module
 * The key table's types, its matching and hint helpers, and `assembleKeys`,
 * which joins the per-area lists in `keys/` into the one table. The editor commands, the window handler, the `<kbd>`
 * hints and the cheat sheet are all made from it, so they cannot drift.
 *
 * A combo is written `Mod+Enter`, `Alt+Shift+K` or `Alt+]`. `Mod` is Ctrl on
 * Windows and Linux and Cmd on macOS. Letters and symbols in a combo with a
 * modifier are matched by physical key, so Alt does not change them on macOS.
 * A plain `outside` binding is a single key (`r`, `?`, `ArrowRight`) that
 * works only when focus is not in a text field; `g c` is a sequence.
 */

export interface KeyDef {
  id: string;
  label: string;
  group: string;
  // Bindings that work while the editor or another text field has focus.
  inField: readonly string[];
  // Bindings that work when focus is not in a text field.
  outside: readonly string[];
  note?: string;
  // Handled by the pane that owns it, not by the window.
  local?: boolean;
  // Place in the table, and so in the cheat sheet. Keys without one follow
  // the ranked ones.
  rank?: number;
  // The play-pane panels (by id) this action belongs to: it opens the tab and
  // is handed to the panel.
  panels?: readonly string[];
}

/**
 * Each file in `keys/` adds its list here, so `ActionId` is the ids of every
 * list and a mistyped action fails the type check.
 */
export interface KeyLists {}

export type ActionId = KeyLists[keyof KeyLists][number]["id"];

/**
 * Types a list so its ids stay literal.
 */
export const defineKeys = <const T extends readonly KeyDef[]>(defs: T) => {
  return defs;
};

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
    ".": "Period",
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

/**
 * Names each module's lists by its file (`shared/keys/slack.ts` is `slack`),
 * ready for `assembleKeys`.
 */
export const areasOf = (
  modules: Record<string, Record<string, readonly KeyDef[]>>,
) => {
  const byArea: Record<string, readonly KeyDef[]> = {};

  for (const [path, module] of Object.entries(modules)) {
    byArea[path.replace(/^.*\//, "").replace(/\.ts$/, "")] =
      Object.values(module).flat();
  }

  return byArea;
};

/**
 * Joins the areas' key lists, by area name, into the one table: the page's own
 * (`core`) first, then each area by name, then ordered by `rank` (keys
 * without one stay after the ranked ones, in that order). An area adds a file
 * of keys and touches no other; the table refuses two actions that share an
 * id, or two that bind the same key.
 */
export const assembleKeys = (byArea: Record<string, readonly KeyDef[]>) => {
  const names = Object.keys(byArea).sort((a, b) => {
    return Number(b === "core") - Number(a === "core") || a.localeCompare(b);
  });
  const joined = names.flatMap((name) => {
    return byArea[name] ?? [];
  });
  const table = joined
    .map((def, at) => {
      return { def, at };
    })
    .sort((a, b) => {
      return (
        (a.def.rank ?? Number.POSITIVE_INFINITY) -
          (b.def.rank ?? Number.POSITIVE_INFINITY) || a.at - b.at
      );
    })
    .map((entry) => {
      return entry.def;
    });
  const problems: string[] = [];
  const ids = new Set<string>();
  const seen = new Map<string, string>();

  for (const def of table) {
    if (ids.has(def.id)) {
      problems.push(`action ${def.id} is defined twice`);
    }

    ids.add(def.id);

    for (const binding of [
      ...def.inField.map((b) => {
        return `in:${b}`;
      }),
      ...def.outside.map((b) => {
        return `out:${b}`;
      }),
    ]) {
      const owner = seen.get(binding);

      if (owner) {
        problems.push(`key ${binding} is bound to both ${owner} and ${def.id}`);
      }

      seen.set(binding, def.id);
    }
  }

  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }

  return table;
};
