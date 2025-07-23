import { defaultDevServerHost } from "./consts.ts";
import { devServerHost as envDevServerHost } from "./env.ts";

// re-export from devserver.ts

/**
 * A simple type map that we can transparently use `fetch` later without having
 * to fall in to the self-referencing `const fetch: typeof fetch = ...` which
 * fails.
 */
type FetchT = typeof fetch;

/**
 * Attempts to contact the dev server, returning a boolean indicating whether or
 * not it was successful.
 *
 * @example devServerUrl(process.env[envKeys.DevServerUrl], "/your-path")
 */
export const devServerAvailable = async (
  /**
   * The host of the dev server. You should pass in an environment variable as
   * this parameter.
   */
  host: string = defaultDevServerHost,

  /**
   * The fetch implementation to use to communicate with the dev server.
   */
  fetch: FetchT,
): Promise<boolean> => {
  try {
    const url = devServerUrl(host, "/dev");
    const result = await fetch(url.toString());
    await result.json();
    return true;
  } catch (_e) {
    return false;
  }
};

/**
 * devServerUrl returns a full URL for the given path name.
 *
 * Because Cloudflare/V8 platforms don't allow process.env, you are expected
 * to pass in the host from the dev server env key:
 *
 * @example devServerUrl(processEnv(envKeys.DevServerUrl), "/your-path")
 * @example devServerUrl("http://localhost:8288/", "/your-path")
 */
export const devServerUrl = (
  host: string = devServerHost(),
  pathname = "",
): URL => {
  return new URL(pathname, host.includes("://") ? host : `http://${host}`);
};

/**
 * devServerHost exports the development server's domain by inspecting env
 * variables, or returns the default development server URL.
 *
 * This guarantees a specific URL as a string, as opposed to the env export
 * which only returns a value of the env var is set.
 */
export const devServerHost = (): string =>
  envDevServerHost() || defaultDevServerHost;
