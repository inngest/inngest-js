/**
 * @module
 * Collects the SDK's type declarations (and `zod`'s) from `node_modules`, so
 * the editor can offer hover and completion for the real API.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const collect = (
  base: string,
  packageRoot: string,
  files: Record<string, string>,
) => {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);

      if (entry === "node_modules") {
        continue;
      }

      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (
        entry === "package.json" ||
        (entry.endsWith(".d.ts") && !entry.endsWith(".d.cts"))
      ) {
        files[`${base}/${relative(packageRoot, path)}`] = readFileSync(
          path,
          "utf8",
        );
      }
    }
  };

  walk(packageRoot);
};

export const readTypes = (root: string) => {
  const files: Record<string, string> = {};

  for (const name of ["inngest", "zod"]) {
    const dir = realpathSync(join(root, "node_modules", name));

    collect(`file:///node_modules/${name}`, dir, files);
  }

  return files;
};
