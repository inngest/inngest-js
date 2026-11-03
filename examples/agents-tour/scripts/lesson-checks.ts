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
import { formatWithBiome } from "../server/biome.ts";
import { type LoadedPage, loadLessons } from "../server/lessons.ts";
import { actionNamed, hintTokens } from "../shared/hints.ts";
import { inlineCodeSpans, resolveSpan } from "../shared/links.ts";
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
  definitions: Record<string, string>,
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

  for (const concept of page.manifest.concepts ?? []) {
    if (!definitions[concept]) {
      say(
        `concept ${concept} has no definition in lessons/_shared/concepts.json`,
      );
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
  let definitions: Record<string, string> = {};

  try {
    ({ pages, definitions } = loadLessons(options.lessonsDir));
  } catch (error) {
    return [...problems, (error as Error).message];
  }

  const files = new Map<string, { where: string; content: string }>();

  for (const page of pages) {
    problems.push(...checkPage(page, options, actions, definitions));

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

/**
 * Warnings, one line per inline code span in a page's text that names nothing
 * in that page's original files. Some spans legitimately are not in the code
 * (an expected output, a value seen only in the Trace), so these never fail
 * the check; the page writer decides.
 */
export const lessonWarnings = (lessonsDir: string = defaults.lessonsDir) => {
  const warnings: string[] = [];

  for (const page of loadLessons(lessonsDir).pages) {
    if (page.manifest.code === false) {
      continue;
    }

    const seen = new Set<string>();

    for (const span of inlineCodeSpans(page.markdown)) {
      if (!seen.has(span) && !resolveSpan(span, page.files)) {
        warnings.push(`${page.id}: \`${span}\` is not in the page's code`);
      }

      seen.add(span);
    }
  }

  return warnings;
};
