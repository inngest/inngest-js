// This file exists to help normalize process.env amongst the backend
// and frontend.  Many frontends (eg. Next, CRA) utilize webpack's DefinePlugin
// along with prefixes, meaning we have to explicitly use the full `process.env.FOO`
// string in order to read variables.

import { type Inngest } from "../components/Inngest";
import { type SupportedFrameworkName } from "../types";
import { version } from "../version";
import { defaultDevServerHost, envKeys, headerKeys } from "./consts";
import { stringifyUnknown } from "./strings";

/**
 * @public
 */
export type Env = Record<string, EnvValue>;

/**
 * @public
 */
export type EnvValue = string | undefined;

/**
 * devServerHost returns the dev server host by searching for the INNGEST_DEVSERVER_URL
 * environment variable (plus project prefixces for eg. react, such as REACT_APP_INNGEST_DEVSERVER_URL).
 *
 * If not found this returns undefined, indicating that the env var has not been set.
 *
 * @example devServerHost()
 */
export const devServerHost = (env: Env = allProcessEnv()): EnvValue => {
  // devServerKeys are the env keys we search for to discover the dev server
  // URL.  This includes the standard key first, then includes prefixed keys
  // for use within common frameworks (eg. CRA, next).
  //
  // We have to fully write these using process.env as they're typically
  // processed using webpack's DefinePlugin, which is dumb and does a straight
  // text replacement instead of actually understanding the AST, despite webpack
  // being fully capable of understanding the AST.
  const prefixes = ["REACT_APP_", "NEXT_PUBLIC_"];
  const keys = [envKeys.InngestBaseUrl, envKeys.InngestDevMode];

  const values = keys.flatMap((key) => {
    return prefixes.map((prefix) => {
      return env[prefix + key];
    });
  });

  return values.find((v) => {
    if (!v) {
      return;
    }

    try {
      return Boolean(new URL(v));
    } catch {
      // no-op
    }
  });
};

const checkFns = (<
  T extends Record<string, (actual: EnvValue, expected: EnvValue) => boolean>,
>(
  checks: T
): T => checks)({
  equals: (actual, expected) => actual === expected,
  "starts with": (actual, expected) =>
    expected ? actual?.startsWith(expected) ?? false : false,
  "is truthy": (actual) => Boolean(actual),
  "is truthy but not": (actual, expected) =>
    Boolean(actual) && actual !== expected,
});

const prodChecks: [
  key: string,
  customCheck: keyof typeof checkFns,
  value?: string,
][] = [
  ["CF_PAGES", "equals", "1"],
  ["CONTEXT", "starts with", "prod"],
  ["ENVIRONMENT", "starts with", "prod"],
  ["NODE_ENV", "starts with", "prod"],
  ["VERCEL_ENV", "starts with", "prod"],
  ["DENO_DEPLOYMENT_ID", "is truthy"],
  [envKeys.VercelEnvKey, "is truthy but not", "development"],
  [envKeys.IsNetlify, "is truthy"],
  [envKeys.IsRender, "is truthy"],
  [envKeys.RailwayBranch, "is truthy"],
  [envKeys.IsCloudflarePages, "is truthy"],
];

interface IsProdOptions {
  /**
   * The optional environment variables to use instead of `process.env`.
   */
  env?: Record<string, unknown>;

  /**
   * The Inngest client that's being used when performing this check. This is
   * used to check if the client has an explicit mode set, and if so, to use
   * that mode instead of inferring it from the environment.
   */
  client?: Inngest.Any;

  /**
   * If specified as a `boolean`, this will be returned as the result of the
   * function. Useful for options that may or may not be set by users.
   */
  explicitMode?: Mode["type"];
}

export interface ModeOptions {
  type: "cloud" | "dev";

  /**
   * Whether the mode was explicitly set, or inferred from other sources.
   */
  isExplicit: boolean;

  /**
   * If the mode was explicitly set as a dev URL, this is the URL that was set.
   */
  explicitDevUrl?: URL;
}

export class Mode {
  public readonly type: "cloud" | "dev";

  /**
   * Whether the mode was explicitly set, or inferred from other sources.
   */
  public readonly isExplicit: boolean;

  public readonly explicitDevUrl?: URL;

  constructor({ type, isExplicit, explicitDevUrl }: ModeOptions) {
    this.type = type;
    this.isExplicit = isExplicit || Boolean(explicitDevUrl);
    this.explicitDevUrl = explicitDevUrl;
  }

  public get isDev(): boolean {
    return this.type === "dev";
  }

  public get isCloud(): boolean {
    return this.type === "cloud";
  }

  public get isInferred(): boolean {
    return !this.isExplicit;
  }

  /**
   * If we are explicitly in a particular mode, retrieve the URL that we are
   * sure we should be using, not considering any environment variables or other
   * influences.
   */
  public getExplicitUrl(defaultCloudUrl: string): string | undefined {
    if (!this.isExplicit) {
      return undefined;
    }

    if (this.explicitDevUrl) {
      return this.explicitDevUrl.href;
    }

    if (this.isCloud) {
      return defaultCloudUrl;
    }

    if (this.isDev) {
      return defaultDevServerHost;
    }

    return undefined;
  }
}

/**
 * Returns the mode of the current environment, based off of either passed
 * environment variables or `process.env`, or explicit settings.
 */
export const getMode = ({
  env = allProcessEnv(),
  client,
  explicitMode,
}: IsProdOptions = {}): Mode => {
  if (explicitMode) {
    return new Mode({ type: explicitMode, isExplicit: true });
  }

  if (client?.["mode"].isExplicit) {
    return client["mode"];
  }

  if (envKeys.InngestDevMode in env) {
    if (typeof env[envKeys.InngestDevMode] === "string") {
      try {
        const explicitDevUrl = new URL(env[envKeys.InngestDevMode]);
        return new Mode({ type: "dev", isExplicit: true, explicitDevUrl });
      } catch {
        // no-op
      }
    }

    const envIsDev = parseAsBoolean(env[envKeys.InngestDevMode]);
    if (typeof envIsDev === "boolean") {
      return new Mode({ type: envIsDev ? "dev" : "cloud", isExplicit: true });
    }
  }

  const isProd = prodChecks.some(([key, checkKey, expected]) => {
    return checkFns[checkKey](stringifyUnknown(env[key]), expected);
  });

  return new Mode({ type: isProd ? "cloud" : "dev", isExplicit: false });
};

/**
 * getEnvironmentName returns the suspected branch name for this environment by
 * searching through a set of common environment variables.
 *
 * This could be used to determine if we're on a branch deploy or not, though it
 * should be noted that we don't know if this is the default branch or not.
 */
export const getEnvironmentName = (env: Env = allProcessEnv()): EnvValue => {
  /**
   * Order is important; more than one of these env vars may be set, so ensure
   * that we check the most specific, most reliable env vars first.
   */
  return (
    env[envKeys.InngestEnvironment] ||
    env[envKeys.BranchName] ||
    env[envKeys.VercelBranch] ||
    env[envKeys.NetlifyBranch] ||
    env[envKeys.CloudflarePagesBranch] ||
    env[envKeys.RenderBranch] ||
    env[envKeys.RailwayBranch]
  );
};

export const processEnv = (key: string): EnvValue => {
  return allProcessEnv()[key];
};

declare const Deno: {
  env: { toObject: () => Env };
};

/**
 * allProcessEnv returns the current process environment variables, or an empty
 * object if they cannot be read, making sure we support environments other than
 * Node such as Deno, too.
 *
 * Using this ensures we don't dangerously access `process.env` in environments
 * where it may not be defined, such as Deno or the browser.
 */
export const allProcessEnv = (): Env => {
  try {
    // eslint-disable-next-line @inngest/internal/process-warn
    if (process.env) {
      // eslint-disable-next-line @inngest/internal/process-warn
      return process.env;
    }
  } catch (_err) {
    // noop
  }

  try {
    const env = Deno.env.toObject();

    if (env) {
      return env;
    }
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
  env?: Env;

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

  /**
   * The Inngest client that's making the request. The client itself will
   * generate a set of headers; specifying it here will ensure that the client's
   * headers are included in the returned headers.
   */
  client?: Inngest;

  /**
   * The Inngest server we expect to be communicating with, used to ensure that
   * various parts of a handshake are all happening with the same type of
   * participant.
   */
  expectedServerKind?: string;

  /**
   * Any additional headers to include in the returned headers.
   */
  extras?: Record<string, string>;
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

  if (opts?.expectedServerKind) {
    headers[headerKeys.InngestExpectedServerKind] = opts.expectedServerKind;
  }

  const env = {
    ...allProcessEnv(),
    ...opts?.env,
  };

  const inngestEnv = opts?.inngestEnv || getEnvironmentName(env);
  if (inngestEnv) {
    headers[headerKeys.Environment] = inngestEnv;
  }

  const platform = getPlatformName(env);
  if (platform) {
    headers[headerKeys.Platform] = platform;
  }

  return {
    ...headers,
    ...opts?.client?.["headers"],
    ...opts?.extras,
  };
};

/**
 * A set of checks that, given an environment, will return `true` if the current
 * environment is running on the platform with the given name.
 */
const platformChecks = {
  /**
   * Vercel Edge Functions don't have access to environment variables unless
   * they are explicitly referenced in the top level code, but they do have a
   * global `EdgeRuntime` variable set that we can use to detect this.
   */
  vercel: (env) =>
    env[envKeys.IsVercel] === "1" || typeof EdgeRuntime === "string",
  netlify: (env) => env[envKeys.IsNetlify] === "true",
  "cloudflare-pages": (env) => env[envKeys.IsCloudflarePages] === "1",
  render: (env) => env[envKeys.IsRender] === "true",
  railway: (env) => Boolean(env[envKeys.RailwayEnvironment]),
} satisfies Record<string, (env: Env) => boolean>;

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
const streamingChecks: Partial<
  Record<
    keyof typeof platformChecks,
    (framework: SupportedFrameworkName, env: Env) => boolean
  >
> = {
  /**
   * "Vercel supports streaming for Serverless Functions, Edge Functions, and
   * React Server Components in Next.js projects."
   *
   * In practice, however, there are many reports of streaming not working as
   * expected on Serverless Functions, so we resort to only allowing streaming
   * for Edge Functions here.
   *
   * See {@link https://vercel.com/docs/frameworks/nextjs#streaming}
   */
  vercel: (_framework, _env) => typeof EdgeRuntime === "string",
};

const getPlatformName = (env: Env) => {
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
  framework: SupportedFrameworkName,
  env: Env = allProcessEnv()
): boolean => {
  return (
    streamingChecks[getPlatformName(env) as keyof typeof streamingChecks]?.(
      framework,
      env
    ) ?? false
  );
};

/**
 * A unique symbol used to mark a custom fetch implementation. We wrap the
 * implementations to provide some extra control when handling errors.
 */
const CUSTOM_FETCH_MARKER = Symbol("Custom fetch implementation");

/**
 * Given a potential fetch function, return the fetch function to use based on
 * this and the environment.
 */
export const getFetch = (givenFetch?: typeof fetch): typeof fetch => {
  /**
   * If we've explicitly been given a fetch function, use that.
   */
  if (givenFetch) {
    if (CUSTOM_FETCH_MARKER in givenFetch) {
      return givenFetch;
    }

    /**
     * We wrap the given fetch function to provide some extra control when
     * handling errors.
     */
    const customFetch: typeof fetch = async (...args) => {
      try {
        return await givenFetch(...args);
      } catch (err) {
        console.warn(
          "A request failed when using a custom fetch implementation; this may be a misconfiguration. Make sure that your fetch client is correctly bound to the global scope."
        );
        throw err;
      }
    };

    /**
     * Mark the custom fetch implementation so that we can identify it later, in
     * addition to adding some runtime properties to it to make it seem as much
     * like the original fetch as possible.
     */
    Object.defineProperties(customFetch, {
      [CUSTOM_FETCH_MARKER]: {},
      name: { value: givenFetch.name },
      length: { value: givenFetch.length },
    });

    return customFetch;
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

/**
 * If `Response` isn't included in this environment, it's probably an earlier
 * Node env that isn't already polyfilling. This function returns either the
 * native `Response` or a polyfilled one.
 */
export const getResponse = (): typeof Response => {
  if (typeof Response !== "undefined") {
    return Response;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-var-requires
  return require("cross-fetch").Response;
};

/**
 * Given an unknown value, try to parse it as a `boolean`. Useful for parsing
 * environment variables that could be a selection of different values such as
 * `"true"`, `"1"`.
 *
 * If the value could not be confidently parsed as a `boolean` or was seen to be
 * `undefined`, this function returns `undefined`.
 */
export const parseAsBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Boolean(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();

    if (trimmed === "undefined") {
      return undefined;
    }

    if (["true", "1"].includes(trimmed)) {
      return true;
    }

    return false;
  }

  return undefined;
};
