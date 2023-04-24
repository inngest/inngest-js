// This file exists to help normalize process.env amongst the backend
// and frontend.  Many frontends (eg. Next, CRA) utilize webpack's DefinePlugin
// along with prefixes, meaning we have to explicitly use the full `process.env.FOO`
// string in order to read variables.

import { version } from "../version";
import { envKeys, headerKeys } from "./consts";
import { stringifyUnknown } from "./strings";

/**
 * devServerHost returns the dev server host by searching for the INNGEST_DEVSERVER_URL
 * environment variable (plus project prefixces for eg. react, such as REACT_APP_INNGEST_DEVSERVER_URL).
 *
 * If not found this returns undefined, indicating that the env var has not been set.
 *
 * @example devServerHost()
 */
export const devServerHost = (): string | undefined => {
  // devServerKeys are the env keys we search for to discover the dev server
  // URL.  This includes the standard key first, then includes prefixed keys
  // for use within common frameworks (eg. CRA, next).
  //
  // We have to fully write these using process.env as they're typically
  // processed using webpack's DefinePlugin, which is dumb and does a straight
  // text replacement instead of actually understanding the AST, despite webpack
  // being fully capable of understanding the AST.
  const values = [
    processEnv(envKeys.DevServerUrl),
    processEnv("REACT_APP_INNGEST_DEVSERVER_URL"),
    processEnv("NEXT_PUBLIC_INNGEST_DEVSERVER_URL"),
  ];

  return values.find((a) => !!a);
};

const prodCheckFns = (<
  T extends Record<
    string,
    (actual: string | undefined, expected: string | undefined) => boolean
  >
>(
  checks: T
): T => checks)({
  equals: (actual, expected) => actual === expected,
  "starts with": (actual, expected) =>
    expected ? actual?.startsWith(expected) ?? false : false,
  "is truthy": (actual) => Boolean(actual),
});

const prodChecks: [
  key: string,
  customCheck: keyof typeof prodCheckFns,
  value?: string
][] = [
  ["CF_PAGES", "equals", "1"],
  ["CONTEXT", "starts with", "prod"],
  ["ENVIRONMENT", "starts with", "prod"],
  ["NODE_ENV", "starts with", "prod"],
  ["VERCEL_ENV", "starts with", "prod"],
  ["DENO_DEPLOYMENT_ID", "is truthy"],
];

/**
 * Returns `true` if we believe the current environment is production based on
 * either passed environment variables or `process.env`.
 */
export const isProd = (
  /**
   * The optional environment variables to use instead of `process.env`.
   */
  env: Record<string, unknown> = allProcessEnv()
): boolean => {
  return prodChecks.some(([key, checkKey, expected]) => {
    return prodCheckFns[checkKey](stringifyUnknown(env[key]), expected);
  });
};

/**
 * getEnvironmentName returns the suspected branch name for this environment by
 * searching through a set of common environment variables.
 *
 * This could be used to determine if we're on a branch deploy or not, though it
 * should be noted that we don't know if this is the default branch or not.
 */
export const getEnvironmentName = (
  env: Record<string, string | undefined> = allProcessEnv()
): string | undefined => {
  /**
   * Order is important; more than one of these env vars may be set, so ensure
   * that we check the most specific, most reliable env vars first.
   */
  return (
    env[envKeys.Environment] ||
    env[envKeys.BranchName] ||
    env[envKeys.VercelBranch] ||
    env[envKeys.NetlifyBranch] ||
    env[envKeys.CloudflarePagesBranch] ||
    env[envKeys.RenderBranch] ||
    env[envKeys.RailwayBranch]
  );
};

export const processEnv = (key: string): string | undefined => {
  return allProcessEnv()[key];
};

declare const Deno: {
  env: { toObject: () => Record<string, string | undefined> };
};

/**
 * allProcessEnv returns the current process environment variables, or an empty
 * object if they cannot be read, making sure we support environments other than
 * Node such as Deno, too.
 *
 * Using this ensures we don't dangerously access `process.env` in environments
 * where it may not be defined, such as Deno or the browser.
 */
export const allProcessEnv = (): Record<string, string | undefined> => {
  try {
    // eslint-disable-next-line @inngest/process-warn
    return process.env;
  } catch (_err) {
    // noop
  }

  try {
    return Deno.env.toObject();
  } catch (_err) {
    // noop
  }

  return {};
};

/**
 * Generate a standardised set of headers based on input and environment
 * variables.
 *
 *
 */
export const inngestHeaders = (opts?: {
  /**
   * The environment variables to use instead of `process.env` or any other
   * default source. Useful for platforms where environment variables are passed
   * in alongside requests.
   */
  env?: Record<string, string | undefined>;

  /**
   * The framework name to use in the `X-Inngest-Framework` header. This is not
   * always available, hence being optional.
   */
  framework?: string;

  /**
   * The environment name to use in the `X-Inngest-Env` header. This is likely
   * to be representative of the target preview environment.
   */
  inngestEnv?: string;
}): Record<string, string> => {
  const sdkVersion = `inngest-js:v${version}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": sdkVersion,
    [headerKeys.SdkVersion]: sdkVersion,
  };

  if (opts?.framework) {
    headers[headerKeys.Framework] = opts.framework;
  }

  const env = opts?.env || allProcessEnv();

  const inngestEnv = opts?.inngestEnv || getEnvironmentName(env);
  if (inngestEnv) {
    headers[headerKeys.Environment] = inngestEnv;
  }

  const platform = getPlatformName(env);
  if (platform) {
    headers[headerKeys.Platform] = platform;
  }

  return headers;
};

/**
 * A set of checks that, given an environment, will return `true` if the current
 * environment is running on the platform with the given name.
 */
const platformChecks = {
  vercel: (env) => env[envKeys.IsVercel] === "1",
  netlify: (env) => env[envKeys.IsNetlify] === "true",
  "cloudflare-pages": (env) => env[envKeys.IsCloudflarePages] === "1",
  render: (env) => env[envKeys.IsRender] === "true",
  railway: (env) => Boolean(env[envKeys.RailwayEnvironment]),
} satisfies Record<
  string,
  (env: Record<string, string | undefined>) => boolean
>;

declare const EdgeRuntime: string | undefined;

/**
 * A set of checks that, given an environment, will return `true` if the current
 * environment and platform supports streaming responses back to Inngest.
 *
 * Streaming capability is both framework and platform-based. Frameworks are
 * supported in serve handlers, and platforms are checked here.
 *
 * As such, this record declares which platforms we explicitly support for
 * streaming and is used by {@link platformSupportsStreaming}.
 */
const streamingChecks = {
  vercel: (_env) => typeof EdgeRuntime === "string",
} satisfies Partial<
  Record<
    keyof typeof platformChecks,
    (env: Record<string, string | undefined>) => boolean
  >
>;

const getPlatformName = (env: Record<string, string | undefined>) => {
  return (Object.keys(platformChecks) as (keyof typeof platformChecks)[]).find(
    (key) => {
      return platformChecks[key](env);
    }
  );
};

/**
 * Returns `true` if we believe the current environment supports streaming
 * responses back to Inngest.
 *
 * We run a check directly related to the platform we believe we're running on,
 * usually based on environment variables.
 */
export const platformSupportsStreaming = (
  env: Record<string, string | undefined> = allProcessEnv()
): boolean => {
  return (
    streamingChecks[getPlatformName(env) as keyof typeof streamingChecks]?.(
      env
    ) ?? false
  );
};

/**
 * Given a potential fetch function, return the fetch function to use based on
 * this and the environment.
 */
export const getFetch = (givenFetch?: typeof fetch): typeof fetch => {
  if (givenFetch) {
    return givenFetch;
  }

  /**
   * Browser or Node 18+
   */
  try {
    if (typeof globalThis !== "undefined" && "fetch" in globalThis) {
      return fetch.bind(globalThis);
    }
  } catch (err) {
    // no-op
  }

  /**
   * Existing polyfilled fetch
   */
  if (typeof fetch !== "undefined") {
    return fetch;
  }

  /**
   * Environments where fetch cannot be found and must be polyfilled
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("cross-fetch") as typeof fetch;
};
