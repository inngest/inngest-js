/**
 * @module
 * Waits until the Dev Server has synced the kit app, so a scenario never sends
 * an event before the functions it triggers are registered.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Polls until the app has written the ids of its functions to `expectFile` and
 * the Dev Server lists every one of them. Throws after `ms`.
 * @param devUrl The Dev Server's URL.
 * @param expectFile The file the app writes its function ids to once it listens.
 * @param ms How long to wait.
 */
export const waitForSync = async (
  devUrl: string,
  expectFile: string,
  ms = 90_000,
): Promise<void> => {
  const end = Date.now() + ms;
  let missing: string[] = ["(the app has not listed its functions yet)"];

  while (Date.now() < end) {
    try {
      if (existsSync(expectFile)) {
        const expected = JSON.parse(
          readFileSync(expectFile, "utf8"),
        ) as string[];
        const res = await fetch(`${devUrl}/dev`);
        const info = (await res.json()) as { functions?: { slug: string }[] };
        const known = new Set(
          (info.functions ?? []).map((fn) => {
            return fn.slug;
          }),
        );

        missing = expected.filter((id) => {
          return !known.has(id);
        });

        if (missing.length === 0) {
          rmSync(expectFile, { force: true });

          return;
        }
      }
    } catch {
      // The Dev Server or the file is not ready yet.
    }

    await sleep(250);
  }

  throw new Error(
    `The Dev Server did not sync the app within ${ms / 1000}s; missing: ${missing.join(", ")}`,
  );
};
