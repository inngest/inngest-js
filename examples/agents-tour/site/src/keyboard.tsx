/**
 * @module
 * The keyboard layer, made from the one key table in `shared/keys.ts`: the
 * window handler, the Monaco commands, and the `<kbd>` hints that follow
 * focus.
 */
import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import {
  type ActionId,
  hintOf,
  keyOf,
  keys,
  matches,
  parseCombo,
} from "../../shared/keys.ts";
import { isMac } from "./platform.ts";

export type Handlers = Record<ActionId, () => void>;

const textTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const inTextField = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;

  return Boolean(
    element &&
      (textTags.has(element.tagName) ||
        element.isContentEditable ||
        element.closest?.(".monaco-editor")),
  );
};

const inMonaco = (target: EventTarget | null) => {
  return Boolean((target as HTMLElement | null)?.closest?.(".monaco-editor"));
};

/**
 * Installs the window handler. `handlers` is read at each key press, so it
 * can change without reinstalling.
 */
export const useKeyboard = (handlers: Handlers, blocked: () => boolean) => {
  const latest = useRef({ handlers, blocked });

  latest.current = { handlers, blocked };

  useEffect(() => {
    let pending = "";
    let timer: number | undefined;

    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) {
        return;
      }

      const target = event.target;
      const field = inTextField(target);
      const fire = (id: ActionId) => {
        event.preventDefault();
        event.stopPropagation();
        latest.current.handlers[id]();
      };

      // Monaco has focus: its own commands (registered from the same table)
      // handle these, so the window must not fire them twice.
      if (inMonaco(target)) {
        return;
      }

      if (latest.current.blocked()) {
        return;
      }

      for (const def of keys) {
        if (
          !def.local &&
          def.inField.some((combo) => {
            return matches(event, combo, isMac);
          })
        ) {
          fire(def.id);

          return;
        }
      }

      if (field) {
        if (event.key === "Escape" && !inMonaco(target)) {
          (target as HTMLElement).blur();
        }

        return;
      }

      if (latest.current.blocked()) {
        return;
      }

      for (const def of keys) {
        if (def.local) {
          continue;
        }

        for (const binding of def.outside) {
          if (binding.includes(" ")) {
            continue;
          }

          // Arrow keys belong to a tab list or a divider that has focus.
          if (
            binding.startsWith("Arrow") &&
            (target as HTMLElement).closest?.('[role="tablist"], [role="separator"]')
          ) {
            continue;
          }

          if (matches(event, binding, isMac)) {
            fire(def.id);
            pending = "";

            return;
          }
        }
      }

      if (pending === "g") {
        const second = event.key.toLowerCase();

        pending = "";
        window.clearTimeout(timer);

        for (const def of keys) {
          if (def.outside.includes(`g ${second}`)) {
            fire(def.id);

            return;
          }
        }

        return;
      }

      if (
        event.key === "g" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        pending = "g";
        timer = window.setTimeout(() => {
          pending = "";
        }, 1500);
      }
    };

    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
};

const monacoKey = (monaco: typeof Monaco, spec: string) => {
  const combo = parseCombo(spec);
  const name = combo.key;
  let code: number | undefined;

  if (name.startsWith("Key") || name.startsWith("Digit")) {
    code = (monaco.KeyCode as unknown as Record<string, number>)[name];
  } else {
    code = (monaco.KeyCode as unknown as Record<string, number>)[name];
  }

  if (code === undefined) {
    return undefined;
  }

  let mask = code;

  if (combo.mod) {
    mask |= monaco.KeyMod.CtrlCmd;
  }

  if (combo.alt) {
    mask |= monaco.KeyMod.Alt;
  }

  if (combo.shift) {
    mask |= monaco.KeyMod.Shift;
  }

  return mask;
};

/**
 * Registers every in-field binding as a Monaco command, plus Esc to leave
 * the editor when no widget of the editor is open.
 */
export const registerEditorCommands = (
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  handlers: () => Handlers,
) => {
  for (const def of keys) {
    for (const combo of def.inField) {
      const binding = monacoKey(monaco, combo);

      if (binding !== undefined) {
        editor.addCommand(binding, () => {
          handlers()[def.id]();
        });
      }
    }
  }

  editor.addCommand(
    monaco.KeyCode.Escape,
    () => {
      handlers().editor();
    },
    "!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible && !renameInputVisible && !editorHasSelection && !inReferenceSearchEditor && !editorHasMultipleSelections && !hasOtherSuggestions && !accessibilityHelpWidgetVisible",
  );
};

/**
 * A `<kbd>` hint. It always shows the binding that works everywhere, inside
 * the editor or not; single keys outside text fields are silent extras.
 */
export const Kbd = ({ action }: { action: ActionId }) => {
  const def = keyOf(action);
  const spec = def.inField[0] ?? def.outside[0];

  if (!spec) {
    return null;
  }

  return <kbd>{hintOf(spec, isMac)}</kbd>;
};

export const shortcutsOf = (action: ActionId) => {
  const def = keyOf(action);
  const toAria = (spec: string) => {
    return spec
      .split("+")
      .map((part) => {
        return part === "Mod" ? (isMac ? "Meta" : "Control") : part;
      })
      .join("+");
  };

  return [...def.inField, ...def.outside]
    .filter((spec) => {
      return !spec.includes(" ");
    })
    .map(toAria)
    .join(" ");
};
