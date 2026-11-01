/**
 * @module
 * The one key table, joined from every list in `shared/keys/`. A clash throws
 * when the site loads.
 */
import {
  type ActionId,
  areasOf,
  assembleKeys,
  type KeyDef,
} from "../../shared/keys.ts";

export const keys = assembleKeys(
  areasOf(
    import.meta.glob<Record<string, readonly KeyDef[]>>(
      "../../shared/keys/*.ts",
      { eager: true },
    ),
  ),
);

export const keyOf = (id: ActionId) => {
  const def = keys.find((candidate) => {
    return candidate.id === id;
  });

  if (!def) {
    throw new Error(`No key for ${id}`);
  }

  return def;
};

/**
 * The actions that belong to one panel's tab.
 */
export const panelKeys = (panel: string) => {
  return keys.filter((def) => {
    return def.panels?.includes(panel);
  });
};
