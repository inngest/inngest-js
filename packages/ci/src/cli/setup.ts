/**
 * Guided setup: asks how the app is started and writes the `ci` key of
 * `inngest.json`, for a person at a terminal who has none yet.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { group, log, text } from "@clack/prompts";

import { conventionStart, defaultPath, readCiSection } from "./config.ts";

/** Thrown when the person cancels a prompt. */
export class Cancelled extends Error {}

const required = (value: string | undefined): string | undefined => {
  return value?.trim() ? undefined : "Required";
};

/** Ask for the start command and path, and write them to `inngest.json`. */
export const guidedSetup = async (root: string): Promise<void> => {
  const answers = await group(
    {
      start: () => {
        return text({
          message: "Which command starts your app? It must listen on PORT.",
          placeholder: "tsx ci/server.ts",
          initialValue: conventionStart(root) ?? "",
          validate: required,
        });
      },
      path: () => {
        return text({
          message: "Where does it serve Inngest?",
          initialValue: defaultPath,
          validate: (value) => {
            return value?.startsWith("/") ? undefined : "Must start with /";
          },
        });
      },
    },
    {
      onCancel: () => {
        throw new Cancelled();
      },
    },
  );

  const file = join(root, "inngest.json");
  const json = existsSync(file)
    ? (JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>)
    : {};

  const ci = { ...(await readCiSection(root)), ...answers };

  await writeFile(file, `${JSON.stringify({ ...json, ci }, null, 2)}\n`);

  log.success(`Saved to ${file}`);
};
