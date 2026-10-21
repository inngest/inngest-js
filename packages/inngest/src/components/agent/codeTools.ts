/**
 * @module
 * EXPERIMENTAL: `codeTools()`, the tools a coding agent needs in a sandbox:
 * read, write, edit, search and run. Each call is one command step in the
 * sandbox, named after the command it runs.
 */
import { z } from "zod/v4";
import { type SandboxTool, tool } from "../sandbox/tools.ts";
import type { DurableSandbox, SandboxDuration } from "../sandbox/types.ts";
import { editText, type TextEdit } from "./editText.ts";

export type CodeToolName = "read" | "write" | "edit" | "search" | "run";

export interface CodeToolsOptions<TName extends CodeToolName = CodeToolName> {
  /**
   * Where relative paths and commands start. Default `/work`.
   */
  cwd?: string;

  /**
   * The longest one command may run. Default 5 minutes.
   */
  timeout?: SandboxDuration;

  /**
   * Only these tools. Default all of them.
   */
  only?: TName[];
}

const searchScript = `
if command -v rg >/dev/null 2>&1; then
  rg --line-number --max-count 20 -e "$PAT" -- "$P"
else
  grep -rn -e "$PAT" -- "$P"
fi | head -100
`;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// A failed sandbox step carries the API's status and code as its cause.
const isFileNotFound = (error: unknown): boolean => {
  const cause = (error as { cause?: { status?: number; code?: string } })
    ?.cause;

  return cause?.status === 404 && cause.code !== "sandbox_not_found";
};

/**
 * EXPERIMENTAL: Tools for a model to work on code in `sandbox`: `read`,
 * `write`, `edit`, `search` and `run`. Hand them to `agent.loop()`.
 *
 * `edit` replaces exact text, like the text editor tools models are trained
 * on, and runs in your app: it reads the file, changes it and writes it back,
 * so the sandbox needs nothing installed. A command that exits non-zero is a
 * result the model sees, not an error.
 *
 * @example
 * ```ts
 * await agent.loop({
 *   model,
 *   prompt,
 *   tools: codeTools(sandbox, { cwd: "/work/app", only: ["read", "run"] }),
 * });
 * ```
 */
export const codeTools = <TName extends CodeToolName = CodeToolName>(
  sandbox: DurableSandbox,
  options: CodeToolsOptions<TName> = {},
): Record<TName, SandboxTool> => {
  const { cwd = "/work", timeout = "5m" } = options;

  const exec = async (
    id: CodeToolName,
    name: string,
    command: string[],
    environment: Record<string, string> = {},
  ): Promise<string> => {
    const result = await sandbox.commands.run({ id, name }, command, {
      cwd,
      environment,
      timeout,
    });
    const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";

    return `exit ${result.exitCode}\n${result.stdout}${stderr}`;
  };

  const tools: Record<CodeToolName, SandboxTool> = {
    read: tool.group({
      description:
        "Read a file with line numbers. Read a file before editing it. Use from and to to read a range of a large file. Prefer this over cat, head or sed.",
      input: z.object({
        path: z.string(),
        from: z.number().optional(),
        to: z.number().optional(),
      }),
      run: ({ path, from = 1, to = 400 }) => {
        return exec(
          "read",
          `sed -n ${from},${to}p ${path}`,
          ["/bin/sh", "-c", 'nl -ba -- "$P" | sed -n "$A,$B p"'],
          { P: path, A: String(from), B: String(to) },
        );
      },
    }),

    write: tool.group({
      description:
        "Create a new file, or overwrite one completely, with the given content. To change part of an existing file use edit instead.",
      input: z.object({ path: z.string(), content: z.string() }),
      run: ({ path, content }) => {
        return exec(
          "write",
          `write ${path}`,
          [
            "/bin/sh",
            "-c",
            'mkdir -p "$(dirname "$P")" && printf "%s" "$C" > "$P"',
          ],
          { P: path, C: content },
        );
      },
    }),

    edit: tool.group({
      description:
        "Edit a file by exact string replacement. Always read the file first. Prefer this over shell commands (sed, python, perl) for changing files. Each old_string must match exactly once, so include enough surrounding lines to be unique, or set replace_all to change every match. To make several changes in one call, pass edits too: they apply in order, and either all succeed or the file is left unchanged.",
      input: z.object({
        path: z.string(),
        old_string: z.string().optional(),
        new_string: z.string().optional(),
        replace_all: z.boolean().optional(),
        // Models sometimes send an array as a JSON string.
        edits: z
          .preprocess(
            (value) => {
              return typeof value === "string" ? parseJson(value) : value;
            },
            z.array(
              z.object({
                old_string: z.string(),
                new_string: z.string(),
                replace_all: z.boolean().optional(),
              }),
            ),
          )
          .optional()
          .describe("More edits to apply after this one, in order"),
      }),
      run: async ({
        path,
        old_string,
        new_string,
        replace_all,
        edits = [],
      }) => {
        const all: TextEdit[] = [
          ...(old_string === undefined
            ? []
            : [{ old_string, new_string: new_string ?? "", replace_all }]),
          ...edits,
        ];

        if (all.length === 0) {
          throw new Error("Give old_string and new_string, or edits");
        }

        const file = path.startsWith("/") ? path : `${cwd}/${path}`;
        const bytes = await sandbox.files
          .read({ id: "edit:read", name: `read ${path}` }, file)
          .catch((error: unknown) => {
            throw isFileNotFound(error)
              ? new Error(`File not found: ${path}`)
              : error;
          });
        let text: string;

        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error(`${path} is not a UTF-8 text file`);
        }

        await sandbox.files.write(
          { id: "edit:write", name: `edit ${path}` },
          { path: file, data: editText(path, text, all) },
        );

        return `edited ${path}`;
      },
    }),

    search: tool.group({
      description:
        "Search file contents with a regular expression. Prefer this over grep or find.",
      input: z.object({ pattern: z.string(), path: z.string().optional() }),
      run: ({ pattern, path = "." }) => {
        return exec(
          "search",
          `rg ${pattern} ${path}`,
          ["/bin/sh", "-c", searchScript],
          { PAT: pattern, P: path },
        );
      },
    }),

    run: tool.group({
      description:
        "Run a shell command in the repository for building, testing, running code and git. Returns the exit code, stdout and stderr. Do not use it to read, search or edit files; use read, search and edit.",
      input: z.object({ command: z.string() }),
      run: ({ command }) => {
        return exec("run", command, ["/bin/sh", "-c", command]);
      },
    }),
  };

  const names = options.only ?? (Object.keys(tools) as TName[]);

  return Object.fromEntries(
    names.map((name) => {
      return [name, tools[name]];
    }),
  ) as Record<TName, SandboxTool>;
};
