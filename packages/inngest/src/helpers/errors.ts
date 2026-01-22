import chalk from "chalk";
import stringify from "json-stringify-safe";
import {
  type SerializedError as CjsSerializedError,
  deserializeError as cjsDeserializeError,
  serializeError as cjsSerializeError,
  errorConstructors,
} from "serialize-error-cjs";
import stripAnsi from "strip-ansi";
import { z } from "zod/v3";
import type { Inngest } from "../components/Inngest.ts";
import { NonRetriableError } from "../components/NonRetriableError.ts";
import type { ClientOptions, OutgoingOp } from "../types.ts";

const SERIALIZED_KEY = "__serialized";
const SERIALIZED_VALUE = true;

/**
 * Add first-class support for certain errors that we control, in addition to
 * built-in errors such as `TypeError`.
 *
 * Adding these allows these non-standard errors to be correctly serialized,
 * sent to Inngest, then deserialized back into the correct error type for users
 * to react to correctly.
 *
 * Note that these errors only support `message?: string | undefined` as the
 * input; more custom errors are not supported with this current strategy.
 */
errorConstructors.set(
  "NonRetriableError",
  NonRetriableError as ErrorConstructor,
);

export interface SerializedError extends Readonly<CjsSerializedError> {
  readonly [SERIALIZED_KEY]: typeof SERIALIZED_VALUE;
}

/**
 * Serialise an error to a serialized JSON string.
 *
 * Errors do not serialise nicely to JSON, so we use this function to convert
 * them to a serialized JSON string. Doing this is also non-trivial for some
 * errors, so we use the `serialize-error` package to do it for us.
 *
 * See {@link https://www.npmjs.com/package/serialize-error}
 *
 * This function is a small wrapper around that package to also add a `type`
 * property to the serialised error, so that we can distinguish between
 * serialised errors and other objects.
 *
 * Will not reserialise existing serialised errors.
 */
export const serializeError = <
  TAllowUnknown extends boolean = false,
  TOutput extends TAllowUnknown extends true
    ? unknown
    : SerializedError = TAllowUnknown extends true ? unknown : SerializedError,
>(
  /**
   * The suspected error to serialize.
   */
  subject: unknown,

  /**
   * If `true` and the error is not serializable, will return the original value
   * as `unknown` instead of coercing it to a serialized error.
   */
  allowUnknown: TAllowUnknown = false as TAllowUnknown,
): TOutput => {
  try {
    // Try to understand if this is already done.
    // Will handle stringified errors.
    const existingSerializedError = isSerializedError(subject);

    if (existingSerializedError) {
      return existingSerializedError as TOutput;
    }

    if (typeof subject === "object" && subject !== null) {
      // Is an object, so let's try and serialize it.
      const serializedErr = cjsSerializeError(subject as Error);

      // Not a proper error was caught, so give us a chance to return `unknown`.
      if (!serializedErr.name && allowUnknown) {
        return subject as TOutput;
      }

      // Serialization can succeed but assign no name or message, so we'll
      // map over the result here to ensure we have everything.
      // We'll just stringify the entire subject for the message, as this at
      // least provides some context for the user.
      const ret = {
        // Ensure we spread to also capture additional properties such as
        // `cause`.
        ...serializedErr,

        name: serializedErr.name || "Error",
        message:
          serializedErr.message ||
          stringify(subject) ||
          "Unknown error; error serialization could not find a message.",
        stack: serializedErr.stack || "",
        [SERIALIZED_KEY]: SERIALIZED_VALUE,
      } as const;

      // If we have a cause, make sure we recursively serialize them too. We are
      // lighter with causes though; attempt to recursively serialize them, but
      // stop if we find something that doesn't work and just return `unknown`.
      let target: unknown = ret;
      const maxDepth = 5;
      for (let i = 0; i < maxDepth; i++) {
        if (
          typeof target === "object" &&
          target !== null &&
          "cause" in target &&
          target.cause
        ) {
          target = target.cause = serializeError(target.cause, true);
          continue;
        }

        break;
      }

      return ret as TOutput;
    }

    // If it's not an object, it's hard to parse this as an Error. In this case,
    // we'll throw an error to start attempting backup strategies.
    throw new Error("Error is not an object; strange throw value.");
  } catch {
    if (allowUnknown) {
      // If we are allowed to return unknown, we'll just return the original
      // value.
      return subject as TOutput;
    }

    try {
      // If serialization fails, fall back to a regular Error and use the
      // original object as the message for an Error. We don't know what this
      // object looks like, so we can't do anything else with it.
      return {
        ...serializeError(
          new Error(typeof subject === "string" ? subject : stringify(subject)),
          false,
        ),
        // Remove the stack; it's not relevant here
        stack: "",
        [SERIALIZED_KEY]: SERIALIZED_VALUE,
      } as TOutput;
    } catch {
      // If this failed, then stringifying the object also failed, so we'll just
      // return a completely generic error.
      // Failing to stringify the object is very unlikely.
      return {
        name: "Could not serialize source error",
        message: "Serializing the source error failed.",
        stack: "",
        [SERIALIZED_KEY]: SERIALIZED_VALUE,
      } as TOutput;
    }
  }
};

/**
 * Check if an object or a string is a serialised error created by
 * {@link serializeError}.
 */
export const isSerializedError = (
  value: unknown,
): SerializedError | undefined => {
  try {
    if (typeof value === "string") {
      const parsed = z
        .object({
          [SERIALIZED_KEY]: z.literal(SERIALIZED_VALUE),
          name: z.enum([...Array.from(errorConstructors.keys())] as [
            string,
            ...string[],
          ]),
          message: z.string(),
          stack: z.string(),
        })
        .passthrough()
        .safeParse(JSON.parse(value));

      if (parsed.success) {
        return parsed.data as SerializedError;
      }
    }

    if (typeof value === "object" && value !== null) {
      const objIsSerializedErr =
        Object.hasOwn(value, SERIALIZED_KEY) &&
        (value as { [SERIALIZED_KEY]: unknown })[SERIALIZED_KEY] ===
          SERIALIZED_VALUE;

      if (objIsSerializedErr) {
        return value as SerializedError;
      }
    }
  } catch {
    // no-op; we'll return undefined if parsing failed, as it isn't a serialized
    // error
  }

  return;
};

/**
 * Deserialise an error created by {@link serializeError}.
 *
 * Ensures we only deserialise errors that meet a minimum level of
 * applicability, inclusive of error handling to ensure that badly serialized
 * errors are still handled.
 */
export const deserializeError = <
  TAllowUnknown extends boolean = false,
  TOutput extends TAllowUnknown extends true
    ? unknown
    : Error = TAllowUnknown extends true ? unknown : Error,
>(
  subject: Partial<SerializedError>,
  allowUnknown: TAllowUnknown = false as TAllowUnknown,
): TOutput => {
  const requiredFields: (keyof SerializedError)[] = ["name", "message"];

  try {
    const hasRequiredFields = requiredFields.every((field) => {
      return Object.hasOwn(subject, field);
    });

    if (!hasRequiredFields) {
      throw new Error();
    }

    const deserializedErr = cjsDeserializeError(subject as SerializedError);

    if ("cause" in deserializedErr) {
      deserializedErr.cause = deserializeError(
        deserializedErr.cause as Partial<SerializedError>,
        true,
      );
    }

    return deserializedErr as TOutput;
  } catch {
    if (allowUnknown) {
      // If we are allowed to return unknown, we'll just return the original
      // value.
      return subject as TOutput;
    }

    const err = new Error("Unknown error; could not reserialize");

    /**
     * Remove the stack so that it's not misleadingly shown as the Inngest
     * internals.
     */
    err.stack = undefined;

    return err as TOutput;
  }
};

export enum ErrCode {
  NESTING_STEPS = "NESTING_STEPS",

  /**
   * Legacy v0 execution error code for when a function has changed and no
   * longer matches its in-progress state.
   *
   * @deprecated Not for use in latest execution method.
   */
  NON_DETERMINISTIC_FUNCTION = "NON_DETERMINISTIC_FUNCTION",

  /**
   * Legacy v0 execution error code for when a function is found to be using
   * async actions after memoziation has occurred, which v0 doesn't support.
   *
   * @deprecated Not for use in latest execution method.
   */
  ASYNC_DETECTED_AFTER_MEMOIZATION = "ASYNC_DETECTED_AFTER_MEMOIZATION",

  /**
   * Legacy v0 execution error code for when a function is found to be using
   * steps after a non-step async action has occurred.
   *
   * @deprecated Not for use in latest execution method.
   */
  STEP_USED_AFTER_ASYNC = "STEP_USED_AFTER_ASYNC",

  AUTOMATIC_PARALLEL_INDEXING = "AUTOMATIC_PARALLEL_INDEXING",

  NONDETERMINISTIC_STEPS = "NONDETERMINISTIC_STEPS",
}

export interface PrettyError {
  /**
   * The type of message, used to decide on icon and color use.
   */
  type?: "error" | "warn";

  /**
   * A short, succinct description of what happened. Will be used as the error's
   * header, so should be short and to the point with no trailing punctuation.
   */
  whatHappened: string;

  /**
   * If applicable, provide a full sentence to reassure the user about certain
   * details, for example if an error occurred whilst uploading a file, but we
   * can assure the user that uploading succeeded and something internal failed.
   */
  reassurance?: string;

  /**
   * Tell the user why the error happened if we can. This should be a full
   * sentence or paragraph that explains the error in more detail, for example
   * to explain that a file failed to upload because it was too large and that
   * the maximum size is 10MB.
   */
  why?: string;

  /**
   * If applicable, tell the user what the consequences of the error are, for
   * example to tell them that their file was not uploaded and that they will
   * need to try again.
   */
  consequences?: string;

  /**
   * If we can, tell the user what they can do to fix the error now. This should
   * be a full sentence or paragraph that explains what the user can do to fix
   * the error, for example to tell them to try uploading a smaller file or
   * upgrade to a paid plan.
   */
  toFixNow?: string | string[];

  /**
   * If applicable, tell the user what to do if the error persists, they want
   * more information, or the fix we've given them doesn't work.
   *
   * This should be a full sentence or paragraph, and will likely refer users
   * to contact us for support, join our Discord, or read documentation.
   */
  otherwise?: string;

  /**
   * Add a stack trace to the message so that the user knows what line of code
   * the error is in relation to.
   */
  stack?: true;

  /**
   * If applicable, provide a code that the user can use to reference the error
   * when contacting support.
   */
  code?: ErrCode;
}

export const prettyErrorSplitter =
  "=================================================";

/**
 * Given an unknown `err`, mutate it to minify any pretty errors that it
 * contains.
 */
export const minifyPrettyError = <T>(err: T): T => {
  try {
    if (!isError(err)) {
      return err;
    }

    const isPrettyError = err.message.includes(prettyErrorSplitter);
    if (!isPrettyError) {
      return err;
    }

    const sanitizedMessage = stripAnsi(err.message);

    const message =
      sanitizedMessage.split("  ")[1]?.split("\n")[0]?.trim() || err.message;
    const code =
      sanitizedMessage.split("\n\nCode: ")[1]?.split("\n\n")[0]?.trim() ||
      undefined;

    err.message = [code, message].filter(Boolean).join(" - ");

    if (err.stack) {
      const sanitizedStack = stripAnsi(err.stack);
      const stackRest = sanitizedStack
        .split(`${prettyErrorSplitter}\n`)
        .slice(2)
        .join("\n");

      err.stack = `${err.name}: ${err.message}\n${stackRest}`;
    }

    return err;
  } catch (_noopErr) {
    return err;
  }
};

/**
 * Given an `err`, return a boolean representing whether it is in the shape of
 * an `Error` or not.
 */
const isError = (err: unknown): err is Error => {
  try {
    if (err instanceof Error) {
      return true;
    }

    if (typeof err !== "object" || err === null) {
      return false;
    }

    const hasName = Object.hasOwn(err, "name");
    const hasMessage = Object.hasOwn(err, "message");

    return hasName && hasMessage;
  } catch (_noopErr) {
    return false;
  }
};

/**
 * Given an `unknown` object, retrieve the `message` property from it, or fall
 * back to the `fallback` string if it doesn't exist or is empty.
 */
export const getErrorMessage = (err: unknown, fallback: string): string => {
  const { message } = z
    .object({ message: z.string().min(1) })
    .catch({ message: fallback })
    .parse(err);

  return message;
};

/**
 * Given a {@link PrettyError}, return a nicely-formatted string ready to log
 * or throw.
 *
 * Useful for ensuring that errors are logged in a consistent, helpful format
 * across the SDK by prompting for key pieces of information.
 */
export const prettyError = ({
  type = "error",
  whatHappened,
  otherwise,
  reassurance,
  toFixNow,
  why,
  consequences,
  stack,
  code,
}: PrettyError): string => {
  const { icon, colorFn } = (
    {
      error: { icon: "❌", colorFn: chalk.red },
      warn: { icon: "⚠️", colorFn: chalk.yellow },
    } satisfies Record<
      NonNullable<PrettyError["type"]>,
      { icon: string; colorFn: (s: string) => string }
    >
  )[type];

  let header = `${icon}  ${chalk.bold.underline(whatHappened.trim())}`;
  if (stack) {
    header +=
      "\n" +
      [...(new Error().stack?.split("\n").slice(1).filter(Boolean) || [])].join(
        "\n",
      );
  }

  let toFixNowStr =
    (Array.isArray(toFixNow)
      ? toFixNow
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s, i) => `\t${i + 1}. ${s}`)
          .join("\n")
      : toFixNow?.trim()) ?? "";

  if (Array.isArray(toFixNow) && toFixNowStr) {
    toFixNowStr = `To fix this, you can take one of the following courses of action:\n\n${toFixNowStr}`;
  }

  let body = [reassurance?.trim(), why?.trim(), consequences?.trim()]
    .filter(Boolean)
    .join(" ");
  body += body ? `\n\n${toFixNowStr}` : toFixNowStr;

  const trailer = [otherwise?.trim()].filter(Boolean).join(" ");

  const message = [
    prettyErrorSplitter,
    header,
    body,
    trailer,
    code ? `Code: ${code}` : "",
    prettyErrorSplitter,
  ]
    .filter(Boolean)
    .join("\n\n");

  return colorFn(message);
};

export const fixEventKeyMissingSteps = [
  "Set the `INNGEST_EVENT_KEY` environment variable",
  `Pass a key to the \`new Inngest()\` constructor using the \`${
    "eventKey" satisfies keyof ClientOptions
  }\` option`,
];

/**
 * An error that, when thrown, indicates internally that an outgoing operation
 * contains an error.
 *
 * We use this because serialized `data` sent back to Inngest may differ from
 * the error instance itself due to middleware.
 *
 * @internal
 */
export class OutgoingResultError extends Error {
  public readonly result: Pick<OutgoingOp, "data" | "error">;

  constructor(result: Pick<OutgoingOp, "data" | "error">) {
    super("OutgoingOpError");
    this.result = result;
  }
}

/**
 * Create a function that will rethrow an error with a prefix added to the
 * message.
 *
 * Useful for adding context to errors that are rethrown.
 *
 * @example
 * ```ts
 * await doSomeAction().catch(rethrowError("Failed to do some action"));
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional
export const rethrowError = (prefix: string): ((err: any) => never) => {
  return (err) => {
    try {
      err.message &&= `${prefix}; ${err.message}`;
    } catch (_noopErr) {
      // no-op
    } finally {
      // biome-ignore lint/correctness/noUnsafeFinally: intentional
      throw err;
    }
  };
};

/**
 * Legacy v0 execution error for functions that don't support mixing steps and
 * regular async actions.
 */
export const functionStoppedRunningErr = (code: ErrCode) => {
  return prettyError({
    whatHappened: "Your function was stopped from running",
    why: "We detected a mix of asynchronous logic, some using step tooling and some not.",
    consequences:
      "This can cause unexpected behaviour when a function is paused and resumed and is therefore strongly discouraged; we stopped your function to ensure nothing unexpected happened!",
    stack: true,
    toFixNow:
      "Ensure that your function is either entirely step-based or entirely non-step-based, by either wrapping all asynchronous logic in `step.run()` calls or by removing all `step.*()` calls.",
    otherwise:
      "For more information on why step functions work in this manner, see https://www.inngest.com/docs/functions/multi-step#gotchas",
    code,
  });
};
