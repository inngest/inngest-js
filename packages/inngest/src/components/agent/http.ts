/**
 * @module
 * EXPERIMENTAL: What the code that calls an outside HTTP API shares: reading
 * its token, posting JSON with a timeout, and telling a failure worth
 * retrying from one that is not. The Slack and GitHub helpers use it.
 */
import { NonRetriableError } from "../NonRetriableError.ts";

/**
 * The token a channel authenticates with: the option, or what its function
 * returns, or (when the option is not set) the environment variable, or
 * `undefined` when there is none (the request then goes unauthenticated, as
 * to a fake server). A token the caller gave that is blank, or that a function
 * returned as anything but a string, throws a `NonRetriableError` that says
 * so: it is a mistake in the app, such as a binding that was not found, and
 * sending `Bearer ` would fail later with a vaguer error. A function is
 * authoritative: if it returns nothing, that is the error, not a reason to
 * fall back to the environment.
 */
export const resolveToken = async (
  /**
   * The channel's `token` option: a string or a function that returns one.
   */
  option: string | (() => string | Promise<string>) | undefined,

  /**
   * The environment variable read when the option is not set.
   */
  variable: string,

  /**
   * What the token is for, such as `"Slack"`, for the error.
   */
  service: string,
): Promise<string | undefined> => {
  if (option === undefined) {
    return typeof process === "undefined" ? undefined : process.env[variable];
  }

  const token = typeof option === "function" ? await option() : option;

  if (typeof token !== "string" || token.trim() === "") {
    const source =
      typeof option === "function"
        ? "the `token` option function returned"
        : "the `token` option is";
    const what =
      typeof token === "string"
        ? "an empty string"
        : `${typeof token}, not a string`;

    throw new NonRetriableError(
      `${service} token is unusable: ${source} ${what}.`,
    );
  }

  return token;
};

/**
 * The longest an adapter waits for its API.
 */
export const requestTimeoutMs = 10_000;

/**
 * Makes the error for a failed API call: a `NonRetriableError` when trying
 * again cannot help (a client error other than a timeout or a rate limit), a
 * plain `Error` when it can.
 */
export const apiError = (
  /**
   * The message.
   */
  message: string,

  /**
   * Whether a retry could succeed.
   */
  retryable: boolean,
): Error => {
  return retryable ? new Error(message) : new NonRetriableError(message);
};

/**
 * Whether an HTTP status is worth retrying: a timeout, a rate limit or a
 * server error.
 */
export const retryableStatus = (status: number): boolean => {
  return status === 408 || status === 429 || status >= 500;
};

/**
 * POSTs JSON with a timeout. Returns the status and the parsed body (`{}` when
 * the body is not JSON).
 */
export const postJson = async (
  /**
   * The URL.
   */
  url: string,

  /**
   * The request headers; `content-type` is added.
   */
  headers: Record<string, string>,

  /**
   * The JSON body.
   */
  body: unknown,
): Promise<{
  status: number;
  ok: boolean;
  json: Record<string, unknown>;
  limited: boolean;
}> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),

    // A redirect would turn the POST into a GET and report the post as sent.
    redirect: "manual",
  });

  const parsed: unknown = await res.json().catch(() => {
    return {};
  });

  // A body that is not a JSON object (`null`, a list) is no body.
  const json =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  // GitHub answers a secondary rate limit with 403 and one of these.
  const limited =
    res.headers.get("retry-after") !== null ||
    res.headers.get("x-ratelimit-remaining") === "0";

  return { status: res.status, ok: res.ok, json, limited };
};
