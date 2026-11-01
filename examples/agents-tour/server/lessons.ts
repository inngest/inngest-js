/**
 * @module
 * Reads the lessons from disk.
 *
 * ```
 * lessons/_shared/<file>                  read-only files for the whole tour
 * lessons/<nn-module>/module.json         title and opening line
 * lessons/<nn-module>/_shared/<file>      read-only files for one module
 * lessons/<nn-module>/<nn>[a-z]-<page>/   page.md, manifest.json, editable files
 * ```
 *
 * A page's folder starts with its core number; a Go deeper page adds a
 * letter (`03a-`), which becomes its label. A manifest names the read-only
 * files its page shows; each is found in the module's `_shared` folder, then
 * in the tour-wide one, so it is stored once. An exercise page starts from
 * its `stub` folder and keeps its `solution` folder back.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Manifest,
  Module,
  Page,
  PageFile,
  TourIndex,
} from "../shared/types.ts";

const dirs = (path: string) => {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => {
      return entry.isDirectory() && !entry.name.startsWith("_");
    })
    .map((entry) => {
      return entry.name;
    })
    .sort();
};

const titleOf = (markdown: string) => {
  const first = markdown.split("\n")[0] ?? "";

  return first.replace(/^#\s*/, "").trim();
};

const withoutTitle = (markdown: string) => {
  return markdown.split("\n").slice(1).join("\n").trim();
};

const slugOf = (dir: string) => {
  return dir.replace(/^\d+[a-z]?-/, "");
};

const readJson = <T>(path: string) => {
  return JSON.parse(readFileSync(path, "utf8")) as T;
};

export interface LoadedPage extends Page {
  dir: string;
  // What the check runner needs; never sent to the site.
  exerciseFiles?: { check: string; solution: PageFile[] };
}

export interface LoadedLessons {
  pages: LoadedPage[];
  index: TourIndex;
}

export const loadLessons = (lessonsDir: string): LoadedLessons => {
  const pages: LoadedPage[] = [];
  const modules: Module[] = [];
  const tourShared = join(lessonsDir, "_shared");

  for (const moduleDir of dirs(lessonsDir)) {
    const modulePath = join(lessonsDir, moduleDir);
    const meta = readJson<{ title: string; opening: string }>(
      join(modulePath, "module.json"),
    );
    const module: Module = {
      id: slugOf(moduleDir),
      title: meta.title,
      opening: meta.opening,
      pages: [],
    };

    const readShared = (page: string, name: string) => {
      for (const folder of [join(modulePath, "_shared"), tourShared]) {
        const path = join(folder, name);

        if (existsSync(path)) {
          return readFileSync(path, "utf8");
        }
      }

      throw new Error(`${page}: no shared file ${name}`);
    };

    for (const pageDir of dirs(modulePath)) {
      const match = /^(\d+)([a-z]?)-/.exec(pageDir);

      if (!match) {
        throw new Error(
          `${moduleDir}/${pageDir}: a page folder is <nn>-<slug>`,
        );
      }

      const dir = join(modulePath, pageDir);
      const id = `${module.id}/${slugOf(pageDir)}`;
      const markdown = readFileSync(join(dir, "page.md"), "utf8");
      const manifest = readJson<Manifest>(join(dir, "manifest.json"));
      const files: PageFile[] = [];
      let exerciseFiles: LoadedPage["exerciseFiles"];

      if (manifest.code !== false) {
        const exercise = manifest.exercise;

        for (const name of manifest.editable ?? ["agent.ts"]) {
          files.push({
            name,
            content: readFileSync(
              join(dir, exercise ? exercise.stub : "", name),
              "utf8",
            ),
            editable: true,
          });
        }

        for (const name of manifest.readOnly ?? ["setup.ts"]) {
          files.push({
            name,
            content: readShared(id, name),
            editable: false,
          });
        }

        if (exercise) {
          exerciseFiles = {
            check: join(dir, exercise.check),
            solution: files
              .filter((file) => {
                return file.editable;
              })
              .map((file) => {
                return {
                  ...file,
                  content: readFileSync(
                    join(dir, exercise.solution, file.name),
                    "utf8",
                  ),
                };
              }),
          };
        }
      }

      const number = Number.parseInt(match[1] as string, 10);
      const page: LoadedPage = {
        id,
        number,
        label: `${number}${match[2]}`,
        kind: manifest.kind ?? "core",
        module: module.id,
        moduleTitle: module.title,
        title: titleOf(markdown),
        markdown: withoutTitle(markdown),
        files,
        manifest,
        exercise: manifest.exercise !== undefined,
        dir,
        exerciseFiles,
      };

      pages.push(page);
      module.pages.push({
        id: page.id,
        number: page.number,
        label: page.label,
        kind: page.kind,
        module: page.module,
        moduleTitle: page.moduleTitle,
        title: page.title,
      });
    }

    modules.push(module);
  }

  return { pages, index: { modules } };
};
