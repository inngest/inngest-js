/**
 * @module
 * EXPERIMENTAL: `sandbox.tools.code()`, the tools a coding agent needs in a
 * sandbox: read, write, edit, search and run. Each call is one command step in
 * the sandbox, named after the command it runs.
 */
import { z } from "zod/v4";
import { editText } from "./editText.ts";
import { type SandboxTool, tool } from "./tools.ts";
import type { DurableSandbox, SandboxDuration } from "./types.ts";

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

// A failed sandbox step carries the API's status and code as its cause.
const isFileNotFound = (error: unknown): boolean => {
  const cause = (error as { cause?: { status?: number; code?: string } })
    ?.cause;

  return cause?.status === 404 && cause.code !== "sandbox_not_found";
};

/**
 * EXPERIMENTAL: Tools for a model to work on code in a sandbox: `read`,
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
 *   tools: sandbox.tools.code({ cwd: "/work/app", only: ["read", "run"] }),
 * });
 * ```
 */
export const codeTools = <TName extends CodeToolName = CodeToolName>(
  sandbox: Pick<DurableSandbox, "commands" | "files">,
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
        "Read a file with line numbers. Use from and to to read a range.",
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
      description: "Create or overwrite a file with the given content.",
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
        "Edit a file by replacing exact text. old_string must match exactly once, or set replace_all to replace every match.",
      input: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      run: async ({ path, ...edit }) => {
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
          { path: file, data: editText(path, text, edit) },
        );

        return `edited ${path}`;
      },
    }),

    search: tool.group({
      description: "Search file contents with a regular expression.",
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
        "Run a shell command in the repository. Returns the exit code, stdout and stderr.",
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
