import { NonRetriableError } from "../components/NonRetriableError";

export const marshalError = (err: unknown): Record<string, any> | string => {
  if (err instanceof NonRetriableError) {
    return {
      message: err.message,
      stack: err.stack,
      name: err.name,
      cause: err.cause
        ? err.cause instanceof Error
          ? marshalError(err.cause)
          : JSON.stringify(err.cause)
        : undefined,
    };
  }

  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack,
      name: err.name,
    };
  }

  return `Unknown error: ${JSON.stringify(err)}`;
};

export const stringifyError = (err: unknown): string => {
  const result = marshalError(err);
  return typeof result === "string" ? result : JSON.stringify(result);
};
