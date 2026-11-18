/**
 * @module
 * EXPERIMENTAL: `classifyModelError`, which says which model errors are worth
 * retrying. The loop and `anthropic()` apply it to every model call.
 */
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import { RetryAfterError } from "../../../components/RetryAfterError.ts";

/**
 * Statuses that a retry can fix although they are 4xx: the request timed out,
 * conflicted with another, or hit a rate limit.
 */
const retriableClientStatuses = new Set([408, 409, 429]);

/**
 * Provider error types that name a request no retry can fix, for an error that
 * has no status. Anthropic and OpenAI both use these.
 */
const permanentTypes = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "invalid_api_key",
  "unsupported_country_region_territory",
]);

/**
 * OpenAI answers an account out of quota with a 429, the status of a rate limit
 * that passes, so this type decides before the status does.
 */
const quotaType = "insufficient_quota";

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
};

/**
 * The HTTP status an SDK error carries: `status` (Anthropic, OpenAI), then
 * `statusCode`, then `response.status`, then `$metadata.httpStatusCode` (AWS
 * SDK, so Bedrock).
 */
const statusOf = (error: Record<string, unknown>): number | undefined => {
  for (const candidate of [
    error.status,
    error.statusCode,
    asRecord(error.response)?.status,
    asRecord(error.$metadata)?.httpStatusCode,
  ]) {
    if (typeof candidate === "number") {
      return candidate;
    }
  }

  return undefined;
};

/**
 * Every error type the error names, as in `{ error: { type: "..." } }` and
 * Anthropic's `{ type: "error", error: { type: "..." } }`, or `type` or
 * `code` on the error itself.
 */
const typesOf = (error: Record<string, unknown>): string[] => {
  const body = asRecord(error.error);

  return [
    body?.type,
    asRecord(body?.error)?.type,
    asRecord(error.body)?.type,
    error.type,
    error.code,
  ].filter((candidate): candidate is string => {
    return typeof candidate === "string";
  });
};

/**
 * EXPERIMENTAL: Decides whether a model call's error is worth retrying, for
 * the `model` function of `agent.loop()` or any durable loop of your own. A
 * client error that no retry can fix (a 4xx other than 408, 409 and 429, such
 * as a 400 for a request the model rejects, a 401 or a 404) comes back as a
 * `NonRetriableError` with the original error as its `cause`. Anything else
 * (429, 5xx, overloaded, network errors) comes back as it is, so the step
 * retries.
 *
 * Recognises the `status` of the Anthropic and OpenAI SDK errors, `statusCode`,
 * `response.status` and the AWS SDK's `$metadata.httpStatusCode`. An error with
 * no status (such as one in a streamed response) is judged by the provider's
 * error type: `invalid_request_error` and the like are final,
 * `overloaded_error` and `rate_limit_error` retry. An account out of quota
 * (`insufficient_quota`, sent with a 429) is final too. Only the error itself
 * is read, not its `cause`. `agent.loop()` applies this to every model call.
 */
export const classifyModelError = (error: unknown): unknown => {
  const record = asRecord(error);

  if (!record || error instanceof NonRetriableError) {
    return error;
  }

  const status = statusOf(record);
  const types = typesOf(record);
  const permanent = types.includes(quotaType)
    ? true
    : status !== undefined
      ? status >= 400 && status < 500 && !retriableClientStatuses.has(status)
      : types.some((type) => {
          return permanentTypes.has(type);
        });

  if (!permanent) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : String(record.message ?? error);

  return new NonRetriableError(message, { cause: error });
};

/**
 * Seconds-to-milliseconds of the `retry-after` header an API error carries, so
 * the step retries when the API asked rather than on Inngest's own schedule.
 */
const retryAfterMs = (error: unknown): number | undefined => {
  const headers = (error as { headers?: unknown } | null)?.headers as
    | { get?: (name: string) => string | null }
    | Record<string, string>
    | undefined;
  const read = (name: string): string | null | undefined => {
    return typeof (headers as { get?: unknown })?.get === "function"
      ? (headers as { get: (name: string) => string | null }).get(name)
      : (headers as Record<string, string> | undefined)?.[name];
  };
  const ms = Number(read("retry-after-ms"));
  const seconds = Number(read("retry-after"));

  if (Number.isFinite(ms) && ms > 0) {
    return ms;
  }

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

/**
 * Sorts an error from a model call: a final one becomes a `NonRetriableError`,
 * and a retryable one that names a wait (a 429's `retry-after`) a
 * `RetryAfterError`, so the step retries when the API said it could.
 */
export const sortModelError = (error: unknown): unknown => {
  const sorted = classifyModelError(error);

  if (sorted instanceof NonRetriableError) {
    return sorted;
  }

  const wait = retryAfterMs(error);

  return wait === undefined
    ? sorted
    : new RetryAfterError(
        error instanceof Error ? error.message : String(error),
        wait,
        { cause: error },
      );
};
