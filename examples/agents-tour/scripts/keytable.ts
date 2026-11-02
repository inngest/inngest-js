/**
 * @module
 * The key table for Node: every list in `shared/keys/`, joined by
 * `assembleKeys`. The site builds the same table from the same files.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { areasOf, assembleKeys, type KeyDef } from "../shared/keys.ts";
import { root } from "./lib.ts";

export const loadKeyTable = async (dir = join(root, "shared/keys")) => {
  const modules: Record<string, Record<string, readonly KeyDef[]>> = {};

  for (const file of readdirSync(dir)) {
    if (file.endsWith(".ts")) {
      modules[file] = (await import(
        pathToFileURL(join(dir, file)).href
      )) as Record<string, readonly KeyDef[]>;
    }
  }

  return assembleKeys(areasOf(modules));
};
