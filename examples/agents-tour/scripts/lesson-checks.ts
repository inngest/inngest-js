/**
 * @module
 * What `pnpm tour:check` checks and the type checker cannot. Every page has a
 * title; every file a manifest names exists; a start entry names an agent an
 * editable file defines; every panel a manifest lists is registered; a Go
 * deeper page is not an exercise; every key hint in a page's text names an
 * action; no two actions share a key; and every lesson file is already
 * formatted by the repo's Biome, so Run never changes committed code.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { actionNamed, hintTokens } from "../shared/hints.ts";
import { type LoadedPage, loadLessons } from "../server/lessons.ts";
import { formatWithBiome } from "../server/biome.ts";
import { loadKeyTable } from "./keytable.ts";
import { root } from "./lib.ts";

export interface CheckOptions {
  lessonsDir: string;
  keysDir: string;
  panelsDir: string;
  // Where Biome runs.
  root: string;
}

export const defaults: CheckOptions = {
  lessonsDir: join(root, "lessons"),
  keysDir: join(root, "shared/keys"),
  panelsDir: join(root, "site/src/panels"),
  root,
};

const checkPage = (
  page: LoadedPage,
  options: CheckOptions,
  actions: readonly { id: string }[],
) => {
  const problems: string[] = [];
  const say = (text: string) => {
    problems.push(`${page.id}: ${text}`);
  };

  if (!page.title) {
    say("page.md has no title line");
  }

  for (const name of hintTokens(page.markdown)) {
    if (!actionNamed(actions, name)) {
      say(`{${name}} in the text names no action in the key table`);
    }
  }

  for (const id of page.manifest.panels ?? []) {
    const file = join(options.panelsDir, `${id}.panel.tsx`);

    if (
      !existsSync(file) ||
      !readFileSync(file, "utf8").includes(`id: "${id}"`)
    ) {
      say(`panel ${id} is not registered (panels/${id}.panel.tsx)`);
    }
  }

  if (page.manifest.code === false) {
    return problems;
  }

  if (page.manifest.exercise) {
    if (!existsSync(join(page.dir, page.manifest.exercise.check))) {
      say(`no check file ${page.manifest.exercise.check}`);
    }

    if (page.kind === "deeper") {
      say("a Go deeper page cannot be an exercise");
    }
  }

  const editable = page.files.filter((file) => {
    return file.editable;
  });

  if (editable.length === 0) {
    say("no editable file");
  }

  for (const start of page.manifest.start ?? []) {
    if (
      "agent" in start &&
      !editable.some((file) => {
        return file.content.includes(`"${start.agent}"`);
      })
    ) {
      say(
        `start entry names agent ${start.agent}, which no editable file defines`,
      );
    }
  }

  return problems;
};

/**
 * Returns what is wrong with the lessons, one line each.
 */
export const checkLessons = async (options: CheckOptions = defaults) => {
  const problems: string[] = [];
  let actions: readonly { id: string }[] = [];

  try {
    actions = await loadKeyTable(options.keysDir);
  } catch (error) {
    problems.push((error as Error).message);
  }

  let pages: LoadedPage[] = [];

  try {
    pages = loadLessons(options.lessonsDir).pages;
  } catch (error) {
    return [...problems, (error as Error).message];
  }

  const files = new Map<string, { where: string; content: string }>();

  for (const page of pages) {
    problems.push(...checkPage(page, options, actions));

    for (const file of [
      ...page.files,
      ...(page.exerciseFiles?.solution ?? []),
    ]) {
      files.set(`${file.name}\0${file.content}`, {
        where: `${page.id}: ${file.name}`,
        content: file.content,
      });
    }
  }

  for (const [key, { where, content }] of files) {
    const name = key.split("\0")[0] as string;
    const formatted = await formatWithBiome(options.root, name, content);

    if (!formatted.ok) {
      problems.push(`${where} cannot be formatted by Biome`);
    } else if (formatted.content !== content) {
      problems.push(`${where} is not formatted; run biome format --write`);
    }
  }

  return problems;
};
