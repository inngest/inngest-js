/**
 * @module
 * EXPERIMENTAL: Turns a vendor SDK's HTTP error into the error Inngest should
 * see, for `agent.anthropic()` and `agent.openai()`. Errors are recognised by
 * their `status` and `headers`, never by class, so any version of a vendor's
 * SDK works.
 */
import { NonRetriableError } from "../NonRetriableError.ts";
import { RetryAfterError } from "../RetryAfterError.ts";

const nonRetriable = new Set([400, 401, 403, 404, 413, 422]);
const overloaded = new Set([429, 529]);

type HeadersShape = { get?: (name: string) => string | null } & Record<
  string,
  unknown
>;

const retryAfter = (headers: HeadersShape | undefined): number | undefined => {
  const value =
    typeof headers?.get === "function"
      ? headers.get("retry-after")
      : headers?.["retry-after"];

  if (typeof value !== "string") {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? undefined : Math.max(date - Date.now(), 0);
};

/**
 * Returns the error to throw for a failed model call: a bad request, an
 * unauthorised key or a missing model can't be fixed by retrying, and a rate
 * limit or overload waits as long as the vendor says. Anything else is
 * returned as it is, to be retried with Inngest's backoff.
 */
export const modelError = (error: unknown): unknown => {
  const { status, headers, message } = (error ?? {}) as {
    status?: unknown;
    headers?: HeadersShape;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : String(error);

  if (typeof status !== "number") {
    return error;
  }

  if (nonRetriable.has(status)) {
    return new NonRetriableError(text, { cause: error });
  }

  const wait = overloaded.has(status) ? retryAfter(headers) : undefined;

  return wait === undefined
    ? error
    : new RetryAfterError(text, wait, { cause: error });
};
