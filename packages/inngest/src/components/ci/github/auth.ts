import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import { CiUsageError } from "../errors.ts";

export interface AuthContext {
  installationId?: number;
  owner?: string;
  repo?: string;
}

/**
 * How pipelines talk to GitHub: which client to build, and how checks are
 * reported.
 */
export interface GitHubProvider {
  readonly kind: "app" | "token" | "console";
  /**
   * `"checks"` uses the Checks API, `"statuses"` falls back to commit
   * statuses, and `"console"` prints to the SDK logger.
   */
  readonly reporter: "checks" | "statuses" | "console";
  octokit(ctx?: AuthContext): Promise<Octokit>;
  token(ctx?: AuthContext): Promise<string>;
}

export interface GitHubAppProvider extends GitHubProvider {
  readonly kind: "app";
}

export interface GitHubTokenProvider extends GitHubProvider {
  readonly kind: "token";
}

export interface ConsoleProvider extends GitHubProvider {
  readonly kind: "console";
  /** Every check transition this reporter has seen, for tests and demos. */
  readonly history: ConsoleCheckRecord[];
}

export interface ConsoleCheckRecord {
  at: string;
  pipeline: string;
  name: string;
  status: "in_progress" | "completed";
  conclusion?: string;
  title?: string;
  url?: string;
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Authenticate as a GitHub App, minting an installation token per run.
 *
 * Tokens are only ever minted inside step handlers, so they never appear in
 * step input or output.
 */
export const githubApp = (
  opts: {
    appId?: string;
    privateKey?: string;
    baseUrl?: string;
    /** Used for the HTTP calls, for proxies and for tests. */
    fetch?: typeof fetch;
  } = {},
): GitHubAppProvider => {
  const resolve = () => {
    const appId = opts.appId ?? process.env.GITHUB_APP_ID;
    const privateKey = opts.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY;

    if (!appId || !privateKey) {
      throw new CiUsageError(
        "`githubApp()` needs `appId` and `privateKey`. Set them directly or as `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.",
      );
    }

    return { appId, privateKey: privateKey.replace(/\\n/g, "\n") };
  };

  const octokitFor = async (ctx?: AuthContext): Promise<Octokit> => {
    const { appId, privateKey } = resolve();
    const installationId =
      ctx?.installationId ??
      (process.env.GITHUB_INSTALLATION_ID
        ? Number(process.env.GITHUB_INSTALLATION_ID)
        : undefined);

    if (!installationId) {
      throw new CiUsageError(
        "No GitHub App installation ID was found for this run. GitHub webhook events carry one in `_github.installationId`; set `GITHUB_INSTALLATION_ID` when replaying events locally.",
      );
    }

    return new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey, installationId },
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
    });
  };

  return {
    kind: "app",
    reporter: "checks",
    octokit: octokitFor,
    token: async (ctx) => {
      const octokit = await octokitFor(ctx);
      const auth = (await octokit.auth({ type: "installation" })) as {
        token: string;
      };
      return auth.token;
    },
  };
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Authenticate with a token.
 *
 * The Checks API needs a GitHub App, so checks fall back to commit statuses:
 * there are no summaries or annotations.
 */
export const githubToken = (
  opts: {
    token?: string;
    baseUrl?: string;
    /** Used for the HTTP calls, for proxies and for tests. */
    fetch?: typeof fetch;
  } = {},
): GitHubTokenProvider => {
  const resolve = () => {
    const token = opts.token ?? process.env.GITHUB_TOKEN;
    if (!token) {
      throw new CiUsageError(
        "`githubToken()` needs a token. Pass one directly or set `GITHUB_TOKEN`.",
      );
    }
    return token;
  };

  return {
    kind: "token",
    reporter: "statuses",
    octokit: async () =>
      new Octokit({
        auth: resolve(),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
      }),
    token: async () => resolve(),
  };
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Print checks to the SDK logger instead of sending them to GitHub. This is
 * the default in dev.
 *
 * It only affects checks: `github.rest` calls still need real credentials.
 */
export const consoleReporter = (): ConsoleProvider => {
  const history: ConsoleCheckRecord[] = [];

  const credentialsError = () =>
    new CiUsageError(
      "This pipeline is using the console reporter, which has no GitHub credentials. Pass `github: githubApp({ … })` to `createCi`, or set `INNGEST_CI_GITHUB=live`, to call the GitHub API.",
    );

  return {
    kind: "console",
    reporter: "console",
    history,
    octokit: async () => {
      throw credentialsError();
    },
    token: async () => {
      throw credentialsError();
    },
  };
};

export type { Octokit };
