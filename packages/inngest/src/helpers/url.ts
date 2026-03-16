import { defaultDevServerHost, defaultInngestApiBaseUrl } from "./consts.ts";
import { devServerAvailable } from "./devserver.ts";
import type { Mode } from "./env.ts";

interface ResolveApiBaseUrlOpts {
  /**
   * An explicit API base URL to use. If provided, this will be returned
   * directly without any further logic.
   */
  apiBaseUrl: string | undefined;

  /**
   * The current mode of the SDK, indicating whether it's running in dev or
   * cloud mode and whether that was explicitly set or inferred.
   */
  mode: Mode;

  /**
   * The fetch implementation to use when checking for dev server availability.
   * If not provided, defaults to globalThis.fetch.
   */
  fetch?: typeof fetch;
}

/**
 * Resolves the API base URL based on the provided configuration.
 *
 * The resolution logic follows this order of precedence:
 * 1. If an explicit `apiBaseUrl` is provided, use it directly
 * 2. If in dev mode AND that mode was inferred (not explicitly set), check if
 *    the dev server is available and use it if so
 * 3. Fall back to the production API URL
 *
 * This function is used by both `InngestApi` and `ConnectionCore` to ensure
 * consistent URL resolution logic across the SDK.
 */
export function resolveApiBaseUrl(opts: ResolveApiBaseUrlOpts): string {
  if (opts.apiBaseUrl !== undefined) {
    return opts.apiBaseUrl;
  }

  if (opts.mode === "dev") {
    return defaultDevServerHost;
  }

  return defaultInngestApiBaseUrl;
}
