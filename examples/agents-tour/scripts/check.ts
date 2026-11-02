/**
 * @module
 * `pnpm tour:check`: the lesson checks in `lesson-checks.ts`.
 */
import { checkLessons } from "./lesson-checks.ts";

const problems = await checkLessons();

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log("Every page, manifest, key hint and lesson file looks right.");
