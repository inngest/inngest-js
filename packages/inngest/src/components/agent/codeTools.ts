/**
 * @module
 * EXPERIMENTAL: `codeTools()`, the tools a coding agent needs in a sandbox:
 * read, write, edit, search and run. Each call is one command step in the
 * sandbox, named after the command it runs.
 */
import { z } from "zod/v4";
import { type SandboxTool, tool } from "../sandbox/tools.ts";
import type { DurableSandbox, SandboxDuration } from "../sandbox/types.ts";

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

const editScript = `
import os, sys
path, old, new = os.environ["P"], os.environ["OLD"], os.environ["NEW"]
text = open(path).read()
count = text.count(old)
if count != 1:
    sys.exit(f"old text matched {count} times in {path}; it must match exactly once")
open(path, "w").write(text.replace(old, new))
print("edited " + path)
`;

const searchScript = `
if command -v rg >/dev/null 2>&1; then
  rg --line-number --max-count 20 -e "$PAT" -- "$P"
else
  grep -rn -e "$PAT" -- "$P"
fi | head -100
`;

/**
 * EXPERIMENTAL: Tools for a model to work on code in `sandbox`: `read`,
 * `write`, `edit`, `search` and `run`. Hand them to `agent.loop()`.
 *
 * `edit` needs `python3` in the sandbox image. A command that exits non-zero
 * is a result the model sees, not an error.
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
        "Replace one exact piece of text in a file. The old text must appear exactly once.",
      input: z.object({ path: z.string(), old: z.string(), new: z.string() }),
      run: ({ path, old, new: replacement }) => {
        return exec("edit", `edit ${path}`, ["python3", "-c", editScript], {
          P: path,
          OLD: old,
          NEW: replacement,
        });
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
