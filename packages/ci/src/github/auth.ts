/**
 * GitHub providers: `githubApp`, `githubToken` and `consoleReporter`, and the
 * Octokit clients built from them.
 *
 * @module
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import { NonRetriableError } from "inngest";
import { CiUsageError } from "../errors.ts";
import { mapGitHubError } from "./rest.ts";

export interface AuthContext {
  installationId?: number;
  owner?: string;
  repo?: string;
  /**
   * Narrow the installation token to these repositories of the installation.
   * Without it a token can reach everything the installation can.
   */
  repositoryNames?: string[];
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
  /**
   * The installation that can access a repository, or `undefined` when none
   * can. Only a GitHub App has installations, so other providers leave this
   * out and use the same credentials for every repository.
   */
  installationFor?(owner: string, repo: string): Promise<number | undefined>;
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

  const appOctokit = (): Octokit => {
    const { appId, privateKey } = resolve();

    return new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey },
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
    });
  };

  /** A client for the installation, which can reach all of it. */
  const installationOctokit = (ctx?: AuthContext): Octokit => {
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

  /** A token for the installation, narrowed to `repositoryNames` when given. */
  const installationToken = async (ctx?: AuthContext): Promise<string> => {
    const auth = (await installationOctokit(ctx).auth({
      type: "installation",
      ...(ctx?.repositoryNames ? { repositoryNames: ctx.repositoryNames } : {}),
    })) as { token: string };

    return auth.token;
  };

  const octokitFor = async (ctx?: AuthContext): Promise<Octokit> => {
    if (!ctx?.repositoryNames) {
      return installationOctokit(ctx);
    }

    // A narrowed client authenticates with a token that reaches only those
    // repositories.
    return new Octokit({
      auth: await installationToken(ctx),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
    });
  };

  return {
    kind: "app",
    reporter: "checks",
    octokit: octokitFor,
    installationFor: async (owner, repo) => {
      try {
        // Asked as the App itself, since an installation is what's being found.
        const { data } = await appOctokit().rest.apps.getRepoInstallation({
          owner,
          repo,
        });

        return data.id;
      } catch (error) {
        const status = (error as { status?: number }).status;

        if (status === 404) {
          return undefined;
        }

        const mapped = mapGitHubError(error);

        if (status === 401 || status === 403) {
          // A rate limit is a 403 too, and retries.
          if (mapped && !(mapped instanceof NonRetriableError)) {
            throw mapped;
          }

          throw new NonRetriableError(
            "GitHub rejected the GitHub App's credentials. The App may be suspended, or `appId` and `privateKey` may be wrong.",
            { cause: error },
          );
        }

        throw mapped ?? error;
      }
    },
    token: installationToken,
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
    octokit: async () => {
      return new Octokit({
        auth: resolve(),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
      });
    },
    token: async () => {
      return resolve();
    },
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

  const credentialsError = () => {
    return new CiUsageError(
      "This pipeline is using the console reporter, which has no GitHub credentials. Pass `github: githubApp({ … })` or `githubToken({ … })` to `createCi` to call the GitHub API.",
    );
  };

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
