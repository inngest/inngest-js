/**
 * Getting to a valid config: load it, or detect the project's setup and write
 * it to `inngest.json`, asking a person at a terminal to confirm. This is the
 * flow; the rules it follows are in `analyze.ts`, `detect.ts` and `write.ts`.
 *
 * @module
 */

import { type CiConfig, loadConfig, NoConfigError } from "../config.ts";
import type { Prompter } from "../prompter.ts";
import { describeStarter } from "../render/stateFile.ts";
import { factsOf, missingConfigError } from "./describe.ts";
import { type Candidate, detectProject } from "./detect.ts";
import { ignoreInngest, isInngestIgnored, writeCiConfig } from "./write.ts";

/** A yes-or-no question. */
export const confirm = (
  prompter: Prompter,
  question: string,
): Promise<boolean> => {
  return prompter.choose(question, [
    { label: "Yes", value: true },
    { label: "No", value: false },
  ]);
};

const checkStart = (text: string): string | undefined => {
  return text.trim() === ""
    ? "Enter the command that starts your app."
    : undefined;
};

const checkPath = (text: string): string | undefined => {
  return text.startsWith("/") ? undefined : 'The path must start with "/".';
};

/**
 * Show what was found and let the person accept it, pick another server, or
 * type their own `start` and `path`. Resolves with what to write.
 */
const review = async (
  candidates: Candidate[],
  prompter: Prompter,
): Promise<{ start: string; path: string }> => {
  let candidate = candidates[0] as Candidate;

  while (true) {
    const action = await prompter.review(
      "Run inngest-ci with this?",
      [
        { label: "Yes", value: "accept" },
        ...(candidates.length > 1
          ? [{ label: "Use another server", value: "server" }]
          : []),
        { label: "Edit the start command and path", value: "edit" },
      ],
      factsOf(candidate),
    );

    if (action === "accept") {
      return { start: candidate.start, path: candidate.path };
    }

    if (action === "edit") {
      return {
        start: await prompter.line(
          "Start command",
          checkStart,
          candidate.start,
        ),
        path: await prompter.line("Path", checkPath, candidate.path),
      };
    }

    candidate = await prompter.choose(
      "Which server?",
      candidates.map((option) => {
        return { label: `${option.file}  ${option.start}`, value: option };
      }),
    );
  }
};

/**
 * Resolve the project's config. A missing one is detected and, in a terminal,
 * written after the person confirms it; without a terminal it's an error that
 * says what to write. `again` runs setup even though the config loads, for
 * when it turned out to be wrong.
 */
export const configure = async (opts: {
  root: string;
  gitRoot: string;
  prompter?: Prompter;
  again?: boolean;
}): Promise<CiConfig> => {
  const { root, prompter } = opts;

  if (!opts.again) {
    try {
      return await loadConfig(root);
    } catch (error) {
      if (!(error instanceof NoConfigError)) {
        throw error;
      }
    }
  }

  const detection = await detectProject(root, opts.gitRoot);

  if (!prompter || detection.candidates.length === 0) {
    throw missingConfigError(detection, {
      claude: describeStarter(process.env).kind === "claude",
    });
  }

  await writeCiConfig(root, await review(detection.candidates, prompter));

  if (
    !(await isInngestIgnored(root)) &&
    (await confirm(prompter, "Add .inngest/ to .gitignore?"))
  ) {
    await ignoreInngest(root);
  }

  return loadConfig(root);
};
