/**
 * @module
 * The one key table, joined from every list in `shared/keys/` (the page's
 * own first, then each area's by name). A clash throws when the site loads.
 */
import { type ActionId, assembleKeys, type KeyDef } from "../../shared/keys.ts";

const lists = import.meta.glob<Record<string, KeyDef[]>>(
  "../../shared/keys/*.ts",
  { eager: true },
);

export const keys = assembleKeys(
  Object.entries(lists)
    .sort(([a], [b]) => {
      const core = (name: string) => {
        return Number(name.endsWith("/core.ts"));
      };

      return core(b) - core(a) || a.localeCompare(b);
    })
    .flatMap(([, module]) => {
      return Object.values(module);
    }),
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
