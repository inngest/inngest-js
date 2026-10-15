/**
 * @module
 * Builds the commands that run a snippet of TypeScript or Python in a sandbox
 * with `input` as globals and a top-level `return` as the result.
 *
 * The wrapper is a fixed script and the snippet travels as data (a JSON
 * payload), so nothing a caller passes is ever spliced into source text:
 *
 * - Small payloads ride in the command itself. Large ones are uploaded to a
 *   file first, and the command reads that.
 * - The wrapper writes the JSON of the returned value to a result file once
 *   the process exits cleanly, and `parseRunnerResult` reads it back, so
 *   stdout and stderr stay pure logs, however large the result is.
 *
 * Everything here is pure: running the command, uploading the payload and
 * downloading the result is the caller's job.
 */
import { SandboxValidationError } from "./types.ts";

export type RunnerLanguage = "typescript" | "python";

export interface Runner {
  language: RunnerLanguage;

  /**
   * The snippet. It is the body of an async function, so `await` and `return`
   * work at the top level.
   */
  code: string;

  /**
   * JSON values, each declared as a global (a parameter in TypeScript) before
   * `code` runs.
   */
  input?: Record<string, unknown>;

  /**
   * Where a payload too large for the command is uploaded. Only used then.
   */
  payloadPath: string;

  /**
   * Where the wrapper writes the result. It is empty when there is none.
   */
  resultPath: string;
}

export interface RunnerPlan {
  /**
   * The argv to run in the sandbox.
   */
  command: string[];

  /**
   * A file to upload before running `command`. Set only for large payloads.
   */
  upload?: { path: string; content: string };
}

/**
 * The sandbox's argv limit is 32 KiB in total, and the wrapper takes about 1.
 */
const maxInlinePayloadBytes = 16 * 1024;

const pythonWrapper = String.raw`import ast, asyncio, json, sys

arg, result_path = sys.argv[1], sys.argv[2]
payload = json.load(open(arg[1:])) if arg.startswith("@") else json.loads(arg)

wrapped = ast.parse("async def __inngest_main(): pass")
body = ast.parse(payload["code"], "<code>").body
wrapped.body[0].body = body or wrapped.body[0].body

scope = dict(payload["input"])
exec(compile(wrapped, "<code>", "exec"), scope)

result = asyncio.run(scope["__inngest_main"]())
text = "" if result is None else json.dumps(result, allow_nan=False)
open(result_path, "w").write(text)
`;

const tsWrapper = String.raw`const fs = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");

const [arg, resultPath] = process.argv.slice(-2);
const payload = JSON.parse(arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8") : arg);

const names = Object.keys(payload.input);
let source;
try {
  source = stripTypeScriptTypes("async function __inngest_main(" + names + ") {" + payload.code + "\n}");
} catch (error) {
  if (error.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") throw error;
  console.error("TypeScript snippets support type-only syntax. Enums, namespaces and parameter properties need full TypeScript compilation, so use a const object (or plain functions) instead.\n" + error.message);
  process.exit(1);
}
const main = new Function(source + "\nreturn __inngest_main;")();

let text = "";
process.on("exit", (code) => {
  if (code === 0) fs.writeFileSync(resultPath, text);
});

main(...Object.values(payload.input)).then((result) => {
  text = JSON.stringify(result) ?? "";
});
`;

const commands: Record<
  RunnerLanguage,
  (payload: string, resultPath: string) => string[]
> = {
  typescript: (payload, resultPath) => {
    return [
      "node",
      "--disable-warning=ExperimentalWarning",
      "-e",
      tsWrapper,
      payload,
      resultPath,
    ];
  },
  python: (payload, resultPath) => {
    return ["python3", "-c", pythonWrapper, payload, resultPath];
  },
};

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const reservedNames: Record<RunnerLanguage, ReadonlySet<string>> = {
  typescript: new Set(
    `arguments await break case catch class const continue debugger default
    delete do else enum eval export extends false finally for function if
    implements import in instanceof interface let new null package private
    protected public return static super switch this throw true try typeof
    var void while with yield undefined NaN Infinity console process require
    globalThis Buffer`.split(/\s+/),
  ),
  python: new Set(
    `False None True and as assert async await break class continue def del
    elif else except finally for from global if import in is lambda nonlocal
    not or pass raise return try while with yield print open`.split(/\s+/),
  ),
};

const describe = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return typeof value === "number" ? String(value) : typeof value;
  }

  return value.constructor?.name ?? "object";
};

const assertJson = (
  value: unknown,
  path: string,
  ancestors: unknown[] = [],
): void => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (ancestors.includes(value)) {
    throw new SandboxValidationError(
      `${path} must be a JSON value, got a circular reference`,
    );
  }

  const parents = [...ancestors, value];

  if (Array.isArray(value)) {
    // `Array.from` turns empty slots into `undefined`, which is rejected.
    Array.from(value).forEach((item, index) => {
      assertJson(item, `${path}[${index}]`, parents);
    });

    return;
  }

  const prototype =
    typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (prototype === Object.prototype || prototype === null) {
    for (const [key, item] of Object.entries(value as object)) {
      assertJson(item, `${path}.${key}`, parents);
    }

    return;
  }

  throw new SandboxValidationError(
    `${path} must be a JSON value, got ${describe(value)}`,
  );
};

const assertInput = (
  language: RunnerLanguage,
  input: Record<string, unknown>,
): void => {
  for (const [name, value] of Object.entries(input)) {
    if (
      !identifierPattern.test(name) ||
      name.startsWith("__") ||
      reservedNames[language].has(name)
    ) {
      throw new SandboxValidationError(
        `input.${name} can't be a ${language} global: use a plain name that isn't a reserved word or built-in`,
      );
    }

    assertJson(value, `input.${name}`);
  }
};

/**
 * Lets a snippet be indented to match its source: drops one leading newline
 * and the trailing blank lines, then removes the indentation every non-blank
 * line shares (tabs and spaces count as different characters).
 */
export const dedentCode = (code: string): string => {
  const lines = code
    .replace(/^\r?\n/, "")
    .replace(/(\r?\n[ \t]*)+$/, "")
    .split("\n");

  let margin: string | undefined;
  for (const line of lines.filter((l) => l.trim() !== "")) {
    const indent = line.match(/^[ \t]*/)?.[0] ?? "";
    let shared = 0;
    while (shared < indent.length && indent[shared] === margin?.[shared]) {
      shared++;
    }

    margin = margin === undefined ? indent : margin.slice(0, shared);
  }

  return lines
    .map((line) => {
      return line.trim() === "" ? "" : line.slice(margin?.length ?? 0);
    })
    .join("\n");
};

/**
 * Validates the input, then returns the command that runs `code`, plus the
 * file it needs when the payload is too large for the command.
 */
export const buildRunner = ({
  language,
  code,
  input = {},
  payloadPath,
  resultPath,
}: Runner): RunnerPlan => {
  assertInput(language, input);

  const payload = JSON.stringify({ code: dedentCode(code), input });
  if (new TextEncoder().encode(payload).byteLength <= maxInlinePayloadBytes) {
    return { command: commands[language](payload, resultPath) };
  }

  return {
    command: commands[language](`@${payloadPath}`, resultPath),
    upload: { path: payloadPath, content: payload },
  };
};

/**
 * The value a runner's result file holds: undefined when the snippet returned
 * nothing.
 */
export const parseRunnerResult = (text: string): unknown => {
  return text === "" ? undefined : JSON.parse(text);
};
