/**
 * @module
 * EXPERIMENTAL: `sandbox.tools`, the tools a coding agent needs in a sandbox:
 * `run`, `read`, `edit`, `search` and `runCode`, as ready-made tool values. List
 * them in `sandbox({ tools })`. Each reads the sandbox it works on from
 * `context.sandbox` when called, so the same value serves every sandbox. Each
 * call is one command step in the sandbox, named after the command it runs.
 * `runCode` runs a script whose code can call tools and wait durably.
 */
import hashjs from "hash.js";
import { z } from "zod/v4";
import { getAsyncCtxSync } from "../execution/als.ts";
import { step } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { editText } from "./editText.ts";
import { buildRunner, parseRunnerResult } from "./runnerScripts.ts";
import {
  bindSandbox,
  liveDescriptions,
  type SandboxTool,
  type SandboxTools,
  tool,
  toolSignature,
} from "./tools.ts";
import {
  type SandboxDuration,
  type SandboxHandle,
  SandboxValidationError,
} from "./types.ts";

/**
 * A built-in tool that takes options with `.with()`, which gives the tool
 * made with them.
 */
export type ConfiguredTool<TTool extends SandboxTool, TOptions> = TTool & {
  /**
   * The same tool with these options. They add to the options it already has.
   */
  with(options: TOptions): ConfiguredTool<TTool, TOptions>;
};

/**
 * Options of `run`, `read` and `search`.
 */
export interface CommandToolOptions {
  /**
   * The longest one command may run. Default 5 minutes.
   */
  timeout?: SandboxDuration;
}

/**
 * Options of `sandbox.tools.run`.
 */
export interface RunToolOptions extends CommandToolOptions {
  /**
   * Whether `run` keeps its working directory and exported environment
   * between calls, like a terminal. Default `true`. With `false` every
   * command starts fresh in the sandbox's `cwd`.
   */
  session?: boolean;
}

/**
 * Options of `sandbox.tools.runCode`.
 */
export interface RunCodeToolOptions {
  /**
   * The longest one run of the script between waits: the clock starts again
   * each time the script runs again after a wait. Default 5 minutes.
   */
  timeout?: SandboxDuration;

  /**
   * Tools the code can call as `tools.name(...)`, besides
   * `tools.sleep({ duration })` and `tools.now()`. They are hidden from the
   * model. A tool declared with `waits` may wait for as long as it likes: the
   * script exits meanwhile, and runs again from the top with its earlier calls
   * answered from a journal. Anything the script does outside tool calls
   * (writing files, starting processes) happens again on each run. `now` and
   * `sleep` are taken. A `tool.group()` among them gets the sandbox as its
   * `context.sandbox`.
   */
  tools?: SandboxTools;
}

const configurable = <TTool extends SandboxTool, TOptions extends object>(
  make: (options: TOptions) => TTool,
  current: TOptions = {} as TOptions,
): ConfiguredTool<TTool, TOptions> => {
  return Object.assign(make(current), {
    with: (options: TOptions) => {
      return configurable(make, { ...current, ...options });
    },
  });
};

// A built-in tool has no sandbox of its own: it works on the one it is listed
// on.
const sandboxOf = (
  name: string,
  context: { sandbox?: SandboxHandle },
): SandboxHandle => {
  if (!context.sandbox) {
    throw new NonRetriableError(
      `${name} works on a sandbox: list it in sandbox({ tools })`,
    );
  }

  return context.sandbox;
};

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

const exec = async (
  sandbox: SandboxHandle,
  id: string,
  name: string,
  command: string[],
  timeout: SandboxDuration,
  environment: Record<string, string> = {},
): Promise<string> => {
  // The shell may start in the thread's saved place or the checkout.
  const current = await sandbox.shell();
  const result = await sandbox.commands.run({ id, name }, command, {
    cwd: current.cwd ?? sandbox.cwd,
    environment,
    timeout,
  });
  const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";

  return `exit ${result.exitCode}\n${result.stdout}${stderr}`;
};

/**
 * EXPERIMENTAL: `sandbox.tools.read`: reads a file with line numbers. List it
 * in `sandbox({ tools })`.
 */
const read = configurable((options: CommandToolOptions) => {
  const { timeout = "5m" } = options;

  return tool.group({
    description:
      "Read a file with line numbers. Use from and to to read a range.",
    input: z.object({
      path: z.string(),
      from: z.number().optional(),
      to: z.number().optional(),
    }),
    run: ({ path, from = 1, to = 400 }, context) => {
      return exec(
        sandboxOf("read", context),
        "read",
        `sed -n ${from},${to}p ${path}`,
        ["/bin/sh", "-c", 'nl -ba -- "$P" | sed -n "$A,$B p"'],
        timeout,
        { P: path, A: String(from), B: String(to) },
      );
    },
  });
});

/**
 * EXPERIMENTAL: `sandbox.tools.edit`: edits a file by replacing exact text,
 * like the text editor tools models are trained on. It runs in your app: it
 * reads the file, changes it and writes it back, so the sandbox needs nothing
 * installed. List it in `sandbox({ tools })`.
 */
const edit = tool.group({
  description:
    "Edit a file by replacing exact text. old_string must match exactly once, or set replace_all to replace every match.",
  input: z.object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  run: async ({ path, ...change }, context) => {
    const sandbox = sandboxOf("edit", context);
    const file = path.startsWith("/")
      ? path
      : `${(await sandbox.shell()).cwd ?? sandbox.cwd}/${path}`;
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
      { path: file, data: editText(path, text, change) },
    );

    return `edited ${path}`;
  },
});

/**
 * EXPERIMENTAL: `sandbox.tools.write`: writes a whole file, creating it and its
 * parent directories if needed. It refuses empty content, so a model can't
 * wipe a file by mistake. Use `edit` to change part of a file. List it in
 * `sandbox({ tools })`.
 */
const write = tool.group({
  description:
    "Write a file with the complete contents given, creating it and its parent directories if needed and replacing it if it exists. To change part of a file, use edit.",
  input: z.object({ path: z.string(), content: z.string() }),
  run: async ({ path, content }, context) => {
    if (content.trim() === "") {
      throw new Error(
        "content is empty; write needs the complete file contents",
      );
    }

    const sandbox = sandboxOf("write", context);
    const cwd = (await sandbox.shell()).cwd ?? sandbox.cwd;
    const file = path.startsWith("/") ? path : `${cwd}/${path}`;
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";

    if (dir !== "") {
      await sandbox.commands.run(
        { id: "write:mkdir", name: `mkdir -p ${dir}` },
        ["mkdir", "-p", dir],
        { cwd },
      );
    }

    await sandbox.files.write(
      { id: "write:write", name: `write ${path}` },
      { path: file, data: content },
    );

    return `wrote ${new TextEncoder().encode(content).length} bytes to ${path}`;
  },
});

/**
 * EXPERIMENTAL: `sandbox.tools.search`: searches file contents with a regular
 * expression. List it in `sandbox({ tools })`.
 */
const search = configurable((options: CommandToolOptions) => {
  const { timeout = "5m" } = options;

  return tool.group({
    description: "Search file contents with a regular expression.",
    input: z.object({ pattern: z.string(), path: z.string().optional() }),
    run: ({ pattern, path = "." }, context) => {
      return exec(
        sandboxOf("search", context),
        "search",
        `rg ${pattern} ${path}`,
        ["/bin/sh", "-c", searchScript],
        timeout,
        { PAT: pattern, P: path },
      );
    },
  });
});

/**
 * EXPERIMENTAL: `sandbox.tools.run`: runs a shell command in the sandbox. The
 * shell keeps its working directory and exported environment between calls,
 * and `read`, `edit`, `write` and `search` start where it is. A command that exits
 * non-zero is a result the model sees, not an error. Options with
 * `run.with({ timeout, session })`.
 *
 * @example
 * ```ts
 * const { run, read } = sandbox.tools;
 *
 * export const work = sandbox({
 *   id: "work",
 *   cwd: "/work/app",
 *   tools: { run: run.with({ timeout: "10m" }), read },
 * });
 * ```
 */
const run = configurable((options: RunToolOptions) => {
  const { timeout = "5m", session: persist = true } = options;

  return tool.group({
    description:
      "Run a shell command in the repository. Returns the exit code, stdout and stderr. The working directory and exported environment variables persist between calls (shell functions, aliases and unexported variables do not), so cd once rather than in every command.",
    input: z.object({ command: z.string() }),
    run: async ({ command }, context) => {
      const sandbox = sandboxOf("run", context);

      if (!persist) {
        return exec(
          sandbox,
          "run",
          command,
          ["/bin/sh", "-c", command],
          timeout,
        );
      }

      const current = await sandbox.shell();
      const before = current.cwd;
      const result = await current.run({ id: "run", name: command }, command, {
        timeout,
      });
      const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";
      const moved =
        current.cwd !== before && current.cwd !== undefined
          ? `\ncwd: ${current.cwd}`
          : "";

      return `exit ${result.exitCode}\n${result.stdout}${stderr}${moved}`;
    },
  });
});

/**
 * EXPERIMENTAL: `sandbox.tools.runCode`: runs a Python or TypeScript script in
 * the sandbox, whose code can call tools and wait durably. Give it tools with
 * `runCode.with({ tools })`.
 */
const runCode = configurable((options: RunCodeToolOptions) => {
  const { timeout = "5m" } = options;

  for (const name of Object.keys(scriptTools)) {
    if (options.tools && Object.hasOwn(options.tools, name)) {
      throw new SandboxValidationError(
        `The tool name "${name}" is built in to runCode; give yours another name`,
      );
    }
  }

  const description =
    'Run a Python or TypeScript snippet (the body of an async function; use return for a result) in the sandbox. `language` is "python" or "typescript" (there is no "javascript": write TypeScript). It can call tools as tools.name(...) and wait with tools.sleep({ duration: "30s" }) (keyword duration= in Python), which can take far longer than a command may run. The snippet runs again from the top after each wait, so it must make the same calls with the same arguments in the same order (get the time from tools.now(), not the clock), and anything it does besides calling tools, such as writing files, happens again on each run. Pass tools lists, not sets: iterating a set of strings can change order between runs.';

  const made = tool.group({
    description,
    input: z.object({
      language: z.enum(["python", "typescript"]),
      code: z.string(),
    }),
    run: async ({ language, code }, context) => {
      const sandbox = sandboxOf("runCode", context);
      const { idempotencyKey } = context;
      const base = `/tmp/inngest-run-code-${hashjs.sha256().update(idempotencyKey).digest("hex").slice(0, 16)}`;
      const resultPath = `${base}.result.json`;
      const plan = buildRunner({
        language,
        code,
        payloadPath: `${base}.json`,
        resultPath,
      });
      // An agent's own tools (discovery and the agent tools) come first, so a
      // tool you list under the same name wins.
      const scripted: SandboxTools = {};
      const given = {
        ...getAsyncCtxSync()?.execution?.agentBridge?.codeTools,
        ...options.tools,
      };

      for (const [name, entry] of Object.entries(given)) {
        scripted[name] = bindSandbox(entry, sandbox);
      }

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
            cwd: sandbox.cwd,
            timeout,
            tools: { ...scriptTools, ...scripted },
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
            { cwd: sandbox.cwd },
          );
        } catch {}
      }
    },
  });

  // The tools code can call, read when the model's tool list is made: the
  // agent's own (its bridge for this run) and the ones given with `with()`.
  liveDescriptions.set(made, () => {
    const given = {
      ...getAsyncCtxSync()?.execution?.agentBridge?.codeTools,
      ...options.tools,
    };
    const lines = Object.entries(given).map(([name, entry]) => {
      return `- ${toolSignature(name, entry)}`;
    });

    return lines.length === 0
      ? description
      : `${description}\nTools your code can call (keyword arguments in Python):\n${lines.join("\n")}`;
  });

  return made;
});

/**
 * EXPERIMENTAL: The built-in tools of a sandbox, ready-made: `run`, `read`,
 * `edit`, `write`, `search` and `runCode`, plus `defaults`, the tools a sandbox with no
 * `tools` brings (`run`). List them in `sandbox({ tools })`; the model sees
 * them as `<sandbox key>_<tool key>`.
 *
 * @example
 * ```ts
 * const { run, read, edit } = sandbox.tools;
 *
 * export const work = sandbox({
 *   id: "work",
 *   cwd: "/work",
 *   tools: { run, read, edit },
 * });
 * ```
 */
export const builtinTools = {
  run,
  read,
  edit,
  write,
  search,
  runCode,

  /**
   * What a sandbox with no `tools` brings: `run`.
   */
  defaults: { run } as { run: typeof run },
};
