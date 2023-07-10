/**
 * Assuming the CWD is the root of the target repo, this script will:
 *
 * Search for a `deno.json` file in the CWD to confirm the target repo is a Deno
 * project.
 *
 * From the `deno.json` file, retrieve the `importMap` property.
 *
 * If found, read the file, merge with our local import map, and write.
 *
 * If not found, maybe assume that this project does not want to use import
 * maps, and will use npm instead? We need to investigate this further with
 * Remix.
 *  It might be the case that we only want to perform Deno compat if we find
 *  both a `deno.json` file and an `importMap` property are found. If not, we
 *  might be able to resort to usual npm linking and leave it at that.
 */
import { deepMerge } from "https://deno.land/std@0.167.0/collections/deep_merge.ts";
import {
  dirname,
  join,
  relative,
  resolve,
} from "https://deno.land/std@0.167.0/path/mod.ts";

console.log('Finding "deno.json" file...');

const denoJson = JSON.parse(
  await Deno.readTextFile(join(Deno.cwd(), "deno.json"))
);
const importMapRelPath = denoJson.importMap;

if (!importMapRelPath) {
  console.error("No import map found in deno.json");
  Deno.exit(0);
}

console.log('Building paths to "import_map.json" and compatibility map...');

const importMapPath = join(Deno.cwd(), importMapRelPath);
const compatImportMapPath = new URL(import.meta.resolve("./import_map.json"))
  .pathname;

console.log('Reading "import_map.json" and compatibility map...');

const [importMap, compatImportMap] = await Promise.all([
  Deno.readTextFile(importMapPath).then(JSON.parse),
  Deno.readTextFile(compatImportMapPath).then(JSON.parse),
]);

console.log("Merging import maps...");

// Adjust all paths in our compat map to point to the correct relative dir from
// the target repo.
compatImportMap.imports = Object.fromEntries(
  Object.entries(compatImportMap.imports).map(([k, v]) => {
    const absolutePath = resolve(dirname(compatImportMapPath), v as string);
    const relativePath = relative(dirname(importMapPath), absolutePath);

    return [k, relativePath];
  })
);

const linkedImportMap = deepMerge(importMap, compatImportMap);

console.log('Writing "import_map.json" to target repo...');

Deno.writeTextFile(importMapPath, JSON.stringify(linkedImportMap, null, 2));

console.log("Done.");
