/**
 * @module
 * The key table for Node: every list in `shared/keys/`, joined by
 * `assembleKeys`. The site builds the same table from the same files.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assembleKeys, type KeyDef } from "../shared/keys.ts";
import { root } from "./lib.ts";

export const loadKeyTable = async (dir = join(root, "shared/keys")) => {
  const lists: KeyDef[][] = [];

  // The page's own keys come first, then each area's in name order.
  const files = readdirSync(dir)
    .filter((file) => {
      return file.endsWith(".ts");
    })
    .sort((a, b) => {
      return (
        Number(b === "core.ts") - Number(a === "core.ts") || a.localeCompare(b)
      );
    });

  for (const file of files) {
    const module = (await import(
      pathToFileURL(join(dir, file)).href
    )) as Record<string, KeyDef[]>;

    lists.push(...Object.values(module));
  }

  return assembleKeys(lists);
};
