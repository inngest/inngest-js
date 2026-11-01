/**
 * @module
 * Typechecks every page the way a reader's Run sees it: each page's files
 * (the starting code, and an exercise's solution) are written into
 * `.tour/typecheck/` with the read-only files beside them, then checked
 * against the real built SDK.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLessons } from "../server/lessons.ts";
import { root, run } from "./lib.ts";

const out = join(root, ".tour", "typecheck");
const { pages } = loadLessons(join(root, "lessons"));

rmSync(out, { recursive: true, force: true });

const write = (dir: string, files: { name: string; content: string }[]) => {
  mkdirSync(dir, { recursive: true });

  for (const file of files) {
    writeFileSync(join(dir, file.name), file.content);
  }
};

for (const page of pages) {
  if (page.files.length === 0) {
    continue;
  }

  write(join(out, page.id, "start"), page.files);

  if (page.exerciseFiles) {
    const solved = new Map(
      page.exerciseFiles.solution.map((file) => {
        return [file.name, file.content];
      }),
    );

    write(
      join(out, page.id, "solution"),
      page.files.map((file) => {
        return {
          name: file.name,
          content: solved.get(file.name) ?? file.content,
        };
      }),
    );
  }
}

writeFileSync(
  join(out, "tsconfig.json"),
  JSON.stringify({
    extends: "../../tsconfig.json",
    include: ["./**/*.ts"],
    exclude: [],
  }),
);

const result = run("npx", [
  "tsc",
  "--noEmit",
  "-p",
  join(out, "tsconfig.json"),
]);

if (!result.ok) {
  console.error(result.out);
  process.exit(1);
}

console.log("Every page typechecks against the built SDK.");
