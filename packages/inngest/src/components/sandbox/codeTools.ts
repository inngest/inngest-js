/**
 * @module
 * EXPERIMENTAL: `sandbox.tools.code()`, the tools a coding agent needs in a
 * sandbox: read, write, edit, search and run. Each call is one command step in
 * the sandbox, named after the command it runs. `run_code` runs a script whose
 * code can call tools and wait durably.
 */
import hashjs from "hash.js";
import { z } from "zod/v4";
import { step } from "../InngestStepTools.ts";
import { editText } from "./editText.ts";
import { buildRunner, parseRunnerResult } from "./runnerScripts.ts";
import { type SandboxTool, type SandboxTools, tool } from "./tools.ts";
import {
  type DurableSandbox,
  type SandboxDuration,
  SandboxValidationError,
} from "./types.ts";

/**
 * The names of the code tools a sandbox can bring: file `read`, `write`,
 * `edit` and `search`, a shell `run`, and `run_code` for a script that calls
 * tools.
 */
export type CodeToolName =
  | "read"
  | "write"
  | "edit"
  | "search"
  | "run"
  | "run_code";

/**
 * Options of `sandbox.tools.code()`.
 */
export interface CodeToolsOptions<TName extends CodeToolName = CodeToolName> {
  /**
   * Where relative paths and commands start. Default `/work`.
   */
  cwd?: string;

  /**
   * The longest one command may run. For `run_code` it is the longest one
   * run of the script between waits: the clock starts again each time the
   * script runs again after a wait. Default 5 minutes.
   */
  timeout?: SandboxDuration;

  /**
   * Only these tools. Default all of them, with `run_code` only when
   * `tools` is given.
   */
  only?: TName[];

  /**
   * Tools the code of `run_code` can call as `tools.name(...)`, besides
   * `tools.sleep({ duration })` and `tools.now()`. A tool declared with
   * `waits` may wait for as long as it likes: the script exits meanwhile, and
   * runs again from the top with its earlier calls answered from a journal.
   * Anything the script does outside tool calls (writing files, starting
   * processes) happens again on each run. `now` and `sleep` are taken.
   */
  tools?: SandboxTools;
}

const scriptTools: SandboxTools = {
  now: tool.step({
    description: "The current time as an ISO string. Same value on replay.",
    run: () => {
      return new Date().toISOString();
    },
  }),
  sleep: tool.group({
    description:
      'Wait without holding the script open: tools.sleep({ duration: "30s" }) (duration="30s" in Python).',
    input: z.object({ duration: z.union([z.string(), z.number()]) }),
    waits: true,
    run: ({ duration }) => {
      return step.sleep("sleep", duration);
    },
  }),
};

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

  for (const name of Object.keys(scriptTools)) {
    if (options.tools && Object.hasOwn(options.tools, name)) {
      throw new SandboxValidationError(
        `The tool name "${name}" is built in to run_code; give yours another name`,
      );
    }
  }

  if (
    options.tools &&
    options.only &&
    !options.only.includes("run_code" as TName)
  ) {
    throw new SandboxValidationError(
      "tools are for run_code, but only leaves it out",
    );
  }

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

  const tools: Record<Exclude<CodeToolName, "run_code">, SandboxTool> & {
    run_code?: SandboxTool;
  } = {
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

  tools.run_code = tool.group({
    description:
      'Run a Python or TypeScript snippet (the body of an async function; use return for a result) in the sandbox. It can call tools as tools.name(...) and wait with tools.sleep({ duration: "30s" }) (keyword duration= in Python), which can take far longer than a command may run. The snippet runs again from the top after each wait, so it must make the same calls with the same arguments in the same order (get the time from tools.now(), not the clock), and anything it does besides calling tools, such as writing files, happens again on each run. Pass tools lists, not sets: iterating a set of strings can change order between runs.',
    input: z.object({
      language: z.enum(["python", "typescript"]),
      code: z.string(),
    }),
    run: async ({ language, code }, { idempotencyKey }) => {
      const base = `/tmp/inngest-run-code-${hashjs.sha256().update(idempotencyKey).digest("hex").slice(0, 16)}`;
      const resultPath = `${base}.result.json`;
      const plan = buildRunner({
        language,
        code,
        payloadPath: `${base}.json`,
        resultPath,
      });

      if (plan.upload) {
        await sandbox.files.write(
          { id: "run_code:payload", name: "write code" },
          { path: plan.upload.path, data: plan.upload.content },
        );
      }

      try {
        const result = await sandbox.commands.run(
          { id: "run_code", name: "run code" },
          plan.command,
          {
            cwd,
            timeout,
            tools: { ...scriptTools, ...options.tools },
          },
        );
        const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";

        if (result.exitCode !== 0) {
          return `exit ${result.exitCode}\n${result.stdout}${stderr}`;
        }

        const bytes = await sandbox.files.read(
          { id: "run_code:result", name: "read result" },
          resultPath,
        );
        const value = parseRunnerResult(new TextDecoder().decode(bytes));
        const returned =
          value === undefined ? "" : `\nreturned:\n${JSON.stringify(value)}`;

        return `exit 0\n${result.stdout}${stderr}${returned}`;
      } finally {
        // Best effort: a gone sandbox mustn't replace the error that got here
        try {
          await sandbox.commands.run(
            { id: "run_code:cleanup", name: "remove files" },
            ["rm", "-f", resultPath, `${base}.json`],
            { cwd },
          );
        } catch {}
      }
    },
  });

  const names =
    options.only ??
    (Object.keys(tools).filter((name) => {
      return name !== "run_code" || options.tools !== undefined;
    }) as TName[]);

  return Object.fromEntries(
    names.map((name) => {
      return [name, tools[name]];
    }),
  ) as Record<TName, SandboxTool>;
};
