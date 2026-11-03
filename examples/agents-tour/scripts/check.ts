/**
 * @module
 * `pnpm tour:check`: the lesson checks in `lesson-checks.ts`, then a warning
 * for each inline code span in a page's text that is not in its code.
 */
import { checkLessons, lessonWarnings } from "./lesson-checks.ts";

const problems = await checkLessons();

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log("Every page, manifest, key hint and lesson file looks right.");

const warnings = lessonWarnings();

if (warnings.length > 0) {
  console.warn(
    `\n${warnings.length} warning(s): code in the text that is not in the page's code. Fine for an expected output or a value seen only in the Trace; otherwise fix the text or the code.`,
  );
  console.warn(warnings.join("\n"));
}
