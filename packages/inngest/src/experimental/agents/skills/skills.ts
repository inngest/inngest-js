/**
 * @module
 * EXPERIMENTAL: skills, know-how the model reads. A skill is a folder with a
 * `SKILL.md` (a name and description in its front matter, then the
 * instructions) and optional scripts and files beside it. Skills are read and
 * tools are called: a skill names tools and never adds any.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { tool } from "../../../components/sandbox/tools.ts";

/**
 * A file of a skill, by path inside the skill's folder.
 */
export interface SkillFile {
  path: string;
  data: Uint8Array;
}

/**
 * One skill: what the model sees up front (`name`, `description`), what
 * `open_skill` returns (`body`) and the files placed in a sandbox.
 */
export interface Skill {
  name: string;
  description: string;

  /**
   * The instructions: `SKILL.md` without its front matter.
   */
  body: string;
  files: SkillFile[];
}

/**
 * Where an agent's skills come from. `skills.folder()` makes one.
 */
export interface SkillSource {
  readonly kind: "inngest/skills.source";
  readonly skills: readonly Skill[];
}

/**
 * What an agent's `skills` field takes: sources, or a function of the run's
 * context that returns them.
 */
export type SkillSources = readonly SkillSource[];

/**
 * The names a skill may have: they become a folder name in the sandbox.
 */
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const unquote = (value: string): string => {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if (
    trimmed.length >= 2 &&
    (quote === '"' || quote === "'") &&
    trimmed.endsWith(quote)
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

/**
 * Splits a `SKILL.md` into its front matter fields and its body. Only
 * single-line `key: value` fields are read.
 */
export const parseSkillMd = (
  text: string,
  where: string,
): { name: string; description: string; body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);

  if (!match) {
    throw new Error(`${where} has no front matter (--- name, description ---)`);
  }

  const fields: Record<string, string> = {};

  for (const line of (match[1] as string).split(/\r?\n/)) {
    const colon = line.indexOf(":");

    if (colon > 0 && !/^\s/.test(line)) {
      fields[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1));
    }
  }

  const name = fields.name;
  const description = fields.description;

  if (!name || !namePattern.test(name)) {
    throw new Error(
      `${where} needs a name of letters, digits, dots, underscores and hyphens in its front matter`,
    );
  }

  if (!description) {
    throw new Error(`${where} needs a description in its front matter`);
  }

  return { name, description, body: match[2] as string };
};

const listFiles = (dir: string): string[] => {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
};

/**
 * Skills shipped with the app: each folder under `path` that holds a
 * `SKILL.md` is a skill. `path` resolves against the process's working
 * directory when this is called, so ship the folder with the app.
 */
const folder = (path: string): SkillSource => {
  const root = resolve(path);
  const found: Skill[] = [];

  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);

    if (!statSync(dir).isDirectory()) {
      continue;
    }

    let text: string;

    try {
      text = readFileSync(join(dir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }

    const parsed = parseSkillMd(text, join(dir, "SKILL.md"));

    found.push({
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      files: listFiles(dir).map((file) => {
        return {
          path: relative(dir, file).split(sep).join("/"),
          data: new Uint8Array(readFileSync(file)),
        };
      }),
    });
  }

  checkNames(found);

  return { kind: "inngest/skills.source", skills: found };
};

const checkNames = (all: readonly Skill[]): void => {
  const seen = new Set<string>();

  for (const skill of all) {
    if (seen.has(skill.name)) {
      throw new Error(`Two skills are named "${skill.name}"`);
    }

    seen.add(skill.name);
  }
};

/**
 * Every skill of the sources, in order. Two with one name are an error.
 */
export const collectSkills = (sources: SkillSources): Skill[] => {
  const all = sources.flatMap((source) => {
    return [...source.skills];
  });

  checkNames(all);

  return all;
};

/**
 * Sources of skills for an agent's `skills` field.
 */
export const skills = { folder };

/**
 * Where a skill's files go in a sandbox: `/skills/<skill name>/`.
 */
export const skillsRoot = "/skills";

/**
 * The text that shows the model each skill's name and description, added to
 * the end of the agent's system prompt. Bodies are not in it.
 */
export const skillsPrompt = (list: readonly Skill[]): string => {
  return [
    "You have skills: know-how you can read when it is relevant. Open one with the open_skill tool, giving its name.",
    ...list.map((skill) => {
      return `- ${skill.name}: ${skill.description}`;
    }),
  ].join("\n");
};

/**
 * The one fixed tool an agent with skills gets, whichever skills it has:
 * `open_skill({ name })` returns the skill's body. It adds no other tool.
 */
export const createSkillTools = (list: readonly Skill[]) => {
  const byName = new Map(
    list.map((skill) => {
      return [skill.name, skill] as const;
    }),
  );

  return {
    open_skill: tool.group({
      description:
        "Open a skill by name and read its instructions. The skills you have are listed in your instructions.",
      input: z.object({ name: z.string() }),
      output: z.string(),
      run: async ({ name }): Promise<string> => {
        const found = byName.get(name);

        if (!found) {
          throw new Error(
            `No skill named ${name}. Skills: ${[...byName.keys()].join(", ")}.`,
          );
        }

        return found.body;
      },
    }),
  };
};
