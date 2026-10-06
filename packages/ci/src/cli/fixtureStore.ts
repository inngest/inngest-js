/**
 * Saved run inputs, so data typed for a manual trigger or a job's input can be
 * used again. One JSON file per name, under the project's `ci.dir`:
 * `<dir>/fixtures/<targetId>/<name>.json`.
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { RunInput } from "./input.ts";
import { SetupError } from "./setupError.ts";

/** What a name may contain, so it's always a safe file name. */
const namePattern = /^[\w.-]+$/;

/** What is wrong with a fixture name, if anything. */
export const checkFixtureName = (name: string): string | undefined => {
  return namePattern.test(name)
    ? undefined
    : "Use letters, numbers, dots, dashes and underscores.";
};

const folder = (dir: string, targetId: string): string => {
  return join(dir, "fixtures", targetId);
};

/** The names saved for a target, sorted. */
export const listFixtures = (dir: string, targetId: string): string[] => {
  const files = existsSync(folder(dir, targetId))
    ? readdirSync(folder(dir, targetId))
    : [];

  return files
    .filter((file) => {
      return file.endsWith(".json");
    })
    .map((file) => {
      return file.slice(0, -".json".length);
    })
    .sort();
};

/** Read a saved input. A missing one is a setup error that lists what exists. */
export const loadFixture = (
  dir: string,
  targetId: string,
  name: string,
): RunInput => {
  const file = join(folder(dir, targetId), `${name}.json`);

  if (!namePattern.test(name) || !existsSync(file)) {
    const saved = listFixtures(dir, targetId);

    throw new SetupError(`No fixture "${name}" for ${targetId}.`, {
      fix: saved.length
        ? `Saved: ${saved.join(", ")}`
        : "Nothing is saved for it yet. Run it in a terminal and enter the data to be offered a save.",
    });
  }

  const { savedAt: _, ...input } = JSON.parse(readFileSync(file, "utf8"));

  return input;
};

/** Save an input under `name`, replacing one with that name. */
export const saveFixture = (opts: {
  dir: string;
  targetId: string;
  name: string;
  input: RunInput;
  now: number;
}): void => {
  const { dir, targetId, name, input, now } = opts;

  mkdirSync(folder(dir, targetId), { recursive: true });

  writeFileSync(
    join(folder(dir, targetId), `${name}.json`),
    `${JSON.stringify({ ...input, savedAt: new Date(now).toISOString() }, null, 2)}\n`,
  );
};

/** Everything saved for a target, by name. */
export const loadFixtures = (
  dir: string,
  targetId: string,
): Record<string, RunInput> => {
  return Object.fromEntries(
    listFixtures(dir, targetId).map((name) => {
      return [name, loadFixture(dir, targetId, name)];
    }),
  );
};
