/**
 * @module
 * `pnpm tour:check`: checks what the type checker cannot. Every page has a
 * title and a manifest; a page's label letter matches its kind; an exercise
 * has a check and a stub and solution for each editable file; a start entry
 * names an agent the page defines; and no two actions share a key.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadLessons } from "../server/lessons.ts";
import { loadKeyTable } from "./keytable.ts";
import { root } from "./lib.ts";

const problems: string[] = [];
const { pages } = loadLessons(join(root, "lessons"));

for (const page of pages) {
  if (!page.title) {
    problems.push(`${page.id}: page.md has no title line`);
  }

  const deeperLabel = /[a-z]$/.test(page.label);

  if (deeperLabel !== (page.kind === "deeper")) {
    problems.push(
      `${page.id}: label ${page.label} and kind ${page.kind} disagree`,
    );
  }

  if (page.manifest.code === false) {
    continue;
  }

  const exercise = page.manifest.exercise;

  if (exercise) {
    if (!existsSync(join(page.dir, exercise.check))) {
      problems.push(`${page.id}: no check file ${exercise.check}`);
    }

    if (page.kind === "deeper") {
      problems.push(`${page.id}: a Go deeper page cannot be an exercise`);
    }
  }

  const editable = page.files.filter((file) => {
    return file.editable;
  });

  if (editable.length === 0) {
    problems.push(`${page.id}: no editable file`);
  }

  for (const start of page.manifest.start ?? []) {
    if (
      "agent" in start &&
      !editable.some((file) => {
        return file.content.includes(`"${start.agent}"`);
      })
    ) {
      problems.push(
        `${page.id}: start event names agent ${start.agent}, which no editable file defines`,
      );
    }
  }
}

let actions = 0;

try {
  actions = (await loadKeyTable()).length;
} catch (error) {
  problems.push(String((error as Error).message));
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`${pages.length} pages and ${actions} actions look right.`);
