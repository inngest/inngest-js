import chalk from "chalk";
import stringify from "json-stringify-safe";
import {
  deserializeError as cjsDeserializeError,
  serializeError as cjsSerializeError,
  errorConstructors,
  type SerializedError as CjsSerializedError,
} from "serialize-error-cjs";
import { z } from "zod";
import { type Inngest } from "../components/Inngest";
import { NonRetriableError } from "../components/NonRetriableError";
import { type ClientOptions, type OutgoingOp } from "../types";

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
  NonRetriableError as ErrorConstructor
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
export const serializeError = (subject: unknown): SerializedError => {
  try {
    // Try to understand if this is already done.
    // Will handle stringified errors.
    const existingSerializedError = isSerializedError(subject);

    if (existingSerializedError) {
      return existingSerializedError;
    }

    if (typeof subject === "object" && subject !== null) {
      // Is an object, so let's try and serialize it.
      const serializedErr = cjsSerializeError(subject as Error);

      // Serialization can succeed but assign no name or message, so we'll
      // map over the result here to ensure we have everything.
      // We'll just stringify the entire subject for the message, as this at
      // least provides some context for the user.
      return {
        name: serializedErr.name || "Error",
        message:
          serializedErr.message ||
          stringify(subject) ||
          "Unknown error; error serialization could not find a message.",
        stack: serializedErr.stack || "",
        [SERIALIZED_KEY]: SERIALIZED_VALUE,
      } as const;
    }

    // If it's not an object, it's hard to parse this as an Error. In this case,
    // we'll throw an error to start attempting backup strategies.
    throw new Error("Error is not an object; strange throw value.");
  } catch (err) {
    try {
      // If serialization fails, fall back to a regular Error and use the
      // original object as the message for an Error. We don't know what this
      // object looks like, so we can't do anything else with it.
      return {
        ...serializeError(
          new Error(typeof subject === "string" ? subject : stringify(subject))
        ),
        [SERIALIZED_KEY]: SERIALIZED_VALUE,
      };
    } catch (err) {
      // If this failed, then stringifying the object also failed, so we'll just
      // return a completely generic error.
      // Failing to stringify the object is very unlikely.
      return {
        name: "Could not serialize source error",
        message: "Serializing the source error failed.",
        stack: "",
        [SERIALIZED_KEY]: SERIALIZED_VALUE,
      };
    }
  }
};

/**
 * Check if an object or a string is a serialised error created by
 * {@link serializeError}.
 */
export const isSerializedError = (
  value: unknown
): SerializedError | undefined => {
  try {
    if (typeof value === "string") {
      const parsed = z
        .object({
          [SERIALIZED_KEY]: z.literal(SERIALIZED_VALUE),
          name: z.enum([...errorConstructors.keys()] as [string, ...string[]]),
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
        Object.prototype.hasOwnProperty.call(value, SERIALIZED_KEY) &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
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
};

/**
 * Deserialise an error created by {@link serializeError}.
 *
 * Ensures we only deserialise errors that meet a minimum level of
 * applicability, inclusive of error handling to ensure that badly serialized
 * errors are still handled.
 */
export const deserializeError = (subject: Partial<SerializedError>): Error => {
  const requiredFields: (keyof SerializedError)[] = ["name", "message"];

  try {
    const hasRequiredFields = requiredFields.every((field) => {
      return Object.prototype.hasOwnProperty.call(subject, field);
    });

    if (!hasRequiredFields) {
      throw new Error();
    }

    return cjsDeserializeError(subject as SerializedError);
  } catch {
    const err = new Error("Unknown error; could not reserialize");

    /**
     * Remove the stack so that it's not misleadingly shown as the Inngest
     * internals.
     */
    err.stack = undefined;

    return err;
  }
};

export enum ErrCode {
  ASYNC_DETECTED_DURING_MEMOIZATION = "ASYNC_DETECTED_DURING_MEMOIZATION",
  ASYNC_DETECTED_AFTER_MEMOIZATION = "ASYNC_DETECTED_AFTER_MEMOIZATION",
  STEP_USED_AFTER_ASYNC = "STEP_USED_AFTER_ASYNC",
  NESTING_STEPS = "NESTING_STEPS",
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

  const splitter = "=================================================";
  let header = `${icon}  ${chalk.bold.underline(whatHappened.trim())}`;
  if (stack) {
    header +=
      "\n" +
      [...(new Error().stack?.split("\n").slice(1).filter(Boolean) || [])].join(
        "\n"
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
    splitter,
    header,
    body,
    trailer,
    code ? `Code: ${code}` : "",
    splitter,
  ]
    .filter(Boolean)
    .join("\n\n");

  return colorFn(message);
};

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

export const fixEventKeyMissingSteps = [
  "Set the `INNGEST_EVENT_KEY` environment variable",
  `Pass a key to the \`new Inngest()\` constructor using the \`${
    "eventKey" satisfies keyof ClientOptions
  }\` option`,
  `Use \`inngest.${"setEventKey" satisfies keyof Inngest}()\` at runtime`,
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
