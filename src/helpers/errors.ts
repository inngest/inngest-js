import {
  deserializeError as cjsDeserializeError,
  serializeError as cjsSerializeError,
} from "serialize-error-cjs";

const SERIALIZED_KEY = "__serialized";
const SERIALIZED_VALUE = true;

export interface SerializedError {
  readonly [SERIALIZED_KEY]: typeof SERIALIZED_VALUE;
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

/**
 * Serialise an error to a plain object.
 *
 * Errors do not serialise nicely to JSON, so we use this function to convert
 * them to a plain object. Doing this is also non-trivial for some errors, so
 * we use the `serialize-error` package to do it for us.
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
  if (isSerializedError(subject)) {
    return subject as SerializedError;
  }

  return {
    ...cjsSerializeError(subject as Error),
    [SERIALIZED_KEY]: SERIALIZED_VALUE,
  } as const;
};

/**
 * Check if an object is a serialised error created by {@link serializeError}.
 */
export const isSerializedError = (value: unknown): boolean => {
  try {
    return (
      Object.prototype.hasOwnProperty.call(value, SERIALIZED_KEY) &&
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (value as { [SERIALIZED_KEY]: unknown })[SERIALIZED_KEY] ===
        SERIALIZED_VALUE
    );
  } catch {
    return false;
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
