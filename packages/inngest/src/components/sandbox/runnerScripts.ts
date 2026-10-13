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
 * - The wrapper prints the JSON of the returned value behind a sentinel as
 *   the last thing on stdout, and `parseRunnerOutput` splits it back off, so
 *   anything the snippet prints stays in `stdout`.
 *
 * Everything here is pure: running the command and uploading the file is the
 * caller's job.
 */
import { SandboxValidationError } from "./types.ts";

export type RunnerLanguage = "ts" | "python";

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

export const resultSentinel = "__INNGEST_RESULT__";

const pythonWrapper = String.raw`import ast, asyncio, json, sys

arg = sys.argv[1]
payload = json.load(open(arg[1:])) if arg.startswith("@") else json.loads(arg)

wrapped = ast.parse("async def __inngest_main(): pass")
body = ast.parse(payload["code"], "<code>").body
wrapped.body[0].body = body or wrapped.body[0].body

scope = dict(payload["input"])
exec(compile(wrapped, "<code>", "exec"), scope)

result = asyncio.run(scope["__inngest_main"]())
text = "" if result is None else json.dumps(result, allow_nan=False)
sys.stdout.write("\n${resultSentinel}" + text + "\n")
`;

const tsWrapper = String.raw`const fs = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");

const arg = process.argv.at(-1);
const payload = JSON.parse(arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8") : arg);

const names = Object.keys(payload.input);
const source = stripTypeScriptTypes("async function __inngest_main(" + names + ") {" + payload.code + "\n}");
const main = new Function(source + "\nreturn __inngest_main;")();

main(...Object.values(payload.input)).then((result) => {
  process.stdout.write("\n${resultSentinel}" + (JSON.stringify(result) ?? "") + "\n");
});
`;

const commands: Record<RunnerLanguage, (payload: string) => string[]> = {
  ts: (payload) => {
    return [
      "node",
      "--disable-warning=ExperimentalWarning",
      "-e",
      tsWrapper,
      payload,
    ];
  },
  python: (payload) => {
    return ["python3", "-c", pythonWrapper, payload];
  },
};

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const reservedNames: Record<RunnerLanguage, ReadonlySet<string>> = {
  ts: new Set(
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

const assertJson = (value: unknown, path: string): void => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJson(item, `${path}[${index}]`);
    });

    return;
  }

  const prototype =
    typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (prototype === Object.prototype || prototype === null) {
    for (const [key, item] of Object.entries(value as object)) {
      assertJson(item, `${path}.${key}`);
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
 * Validates the input, then returns the command that runs `code`, plus the
 * file it needs when the payload is too large for the command.
 */
export const buildRunner = ({
  language,
  code,
  input = {},
  payloadPath,
}: Runner): RunnerPlan => {
  assertInput(language, input);

  const payload = JSON.stringify({ code, input });
  if (new TextEncoder().encode(payload).byteLength <= maxInlinePayloadBytes) {
    return { command: commands[language](payload) };
  }

  return {
    command: commands[language](`@${payloadPath}`),
    upload: { path: payloadPath, content: payload },
  };
};

/**
 * Splits a runner's stdout into what the snippet printed and what it
 * returned. `result` is undefined when it returned nothing or never got that
 * far.
 */
export const parseRunnerOutput = (
  stdout: string,
): { stdout: string; result?: unknown } => {
  const marker = `\n${resultSentinel}`;
  const index = stdout.lastIndexOf(marker);
  if (index === -1) {
    return { stdout };
  }

  const json = stdout.slice(index + marker.length).trim();

  return {
    stdout: stdout.slice(0, index),
    result: json === "" ? undefined : JSON.parse(json),
  };
};
