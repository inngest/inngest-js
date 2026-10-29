/**
 * @module
 * `pnpm tour:check`: checks what the type checker cannot. Every page has a
 * title and a manifest, pages with code have an `agent.ts` and a `setup.ts`,
 * the pages of a lesson share one `setup.ts`, and no two actions share a key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLessons } from "../server/lessons.ts";
import { keys } from "../shared/keys.ts";
import { root } from "./lib.ts";

const problems: string[] = [];
const { pages } = loadLessons(join(root, "lessons"));

const setups = new Map<string, string>();

for (const page of pages) {
  if (!page.title) {
    problems.push(`${page.id}: page.md has no title line`);
  }

  if (page.manifest.code === false) {
    continue;
  }

  const names = page.files.map((file) => {
    return file.name;
  });

  for (const need of ["agent.ts", "setup.ts"]) {
    if (!names.includes(need)) {
      problems.push(`${page.id}: missing ${need}`);
    }
  }

  const setup = readFileSync(join(page.dir, "setup.ts"), "utf8");
  const known = setups.get(page.lesson);

  if (known !== undefined && known !== setup) {
    problems.push(
      `${page.id}: setup.ts differs from the rest of lesson ${page.lesson}`,
    );
  }

  setups.set(page.lesson, known ?? setup);

  for (const start of page.manifest.start ?? []) {
    if (
      "agent" in start &&
      !page.files[0]?.content.includes(`"${start.agent}"`)
    ) {
      problems.push(
        `${page.id}: start message names agent ${start.agent}, which agent.ts does not define`,
      );
    }
  }
}

const seen = new Map<string, string>();

for (const def of keys) {
  for (const binding of [
    ...def.inField.map((b) => `in:${b}`),
    ...def.outside.map((b) => `out:${b}`),
  ]) {
    const owner = seen.get(binding);

    if (owner) {
      problems.push(`key ${binding} is bound to both ${owner} and ${def.id}`);
    }

    seen.set(binding, def.id);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`${pages.length} pages and ${keys.length} actions look right.`);
