/**
 * @module
 * EXPERIMENTAL: authentication as a GitHub App, for the commits, pushes and
 * pull requests an agent makes. `githubApp({ appId, privateKey })` signs the
 * App's JWT, finds the installation on a repository or organization, and
 * trades it for an installation token that can be narrowed to a few
 * repositories and permissions. Tokens are cached until shortly before they
 * expire. It uses only `fetch` and WebCrypto, so it runs in Node, on Workers
 * and in the browser alike.
 *
 * ```ts
 * const app = githubApp({
 *   appId: process.env.GITHUB_APP_ID,
 *   privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
 * });
 *
 * await repo({
 *   repo: "acme/app",
 *   token: () => app.token("acme/app"),
 *   sandbox,
 * });
 * ```
 */

import { NonRetriableError } from "../NonRetriableError.ts";

/**
 * What the App can be asked for a token for: a repository (`"owner/name"`),
 * every repository of an organization or user account the App is installed
 * on (`{ org }`, `{ user }`), or an installation by its ID.
 */
export type GithubAppTarget =
  | string
  | { org: string }
  | { user: string }
  | { installation: number };

/**
 * What a token may do. Left out, it can do all the installation can.
 */
export interface GithubAppTokenOptions {
  /**
   * Permissions to narrow the token to, such as `{ contents: "write" }`.
   */
  permissions?: Record<string, "read" | "write" | "admin">;

  /**
   * Repositories (names, without the owner) to narrow the token to. For a
   * repository target the default is that repository alone, so a token made
   * for `"acme/app"` cannot touch `acme/other`; `"all"` asks for every
   * repository of the installation. For an organization, user or installation
   * target the default is all of them.
   */
  repositories?: string[] | "all";
}

export interface GithubAppOptions {
  /**
   * The App's ID.
   */
  appId: string;

  /**
   * The App's private key, a PEM. `\n` written out as two characters (as a
   * secret store may keep it) is read as a newline. GitHub issues PKCS#1 keys
   * (`BEGIN RSA PRIVATE KEY`) and WebCrypto reads PKCS#8, so a PKCS#1 key is
   * converted.
   */
  privateKey: string;

  /**
   * The GitHub API base URL. Default: `https://api.github.com`.
   */
  apiUrl?: string;

  /**
   * The `fetch` to use. Default: the global one.
   */
  fetch?: typeof fetch;

  /**
   * The `user-agent` header GitHub requires. Default: `inngest-github-app`.
   */
  userAgent?: string;

  /**
   * How long before a token expires it stops being reused, in milliseconds.
   * Default: five minutes.
   */
  refreshMarginMs?: number;

  /**
   * The clock, in milliseconds since the epoch. Default: `Date.now`.
   */
  now?: () => number;
}

/**
 * GitHub answered a request of the App with an error.
 */
export class GithubAppError extends Error {
  /**
   * The HTTP status GitHub answered with.
   */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GithubAppError";
    this.status = status;
  }
}

/**
 * The App is not installed on the repository or account asked for (GitHub
 * answered 404): the one failure a caller may answer by falling back to a
 * person's token. Any other failure is a `GithubAppError` to retry.
 */
export class GithubAppNotInstalledError extends GithubAppError {
  constructor(message: string) {
    super(message, 404);
    this.name = "GithubAppNotInstalledError";
  }
}

/**
 * The App's authentication.
 */
export interface GithubApp {
  /**
   * The App's JWT: RS256, issued a minute in the past for clock drift and
   * valid for nine minutes. It authenticates as the App itself, not as an
   * installation.
   */
  jwt(): Promise<string>;

  /**
   * The installation ID for a target, found once and remembered.
   */
  installationId(target: GithubAppTarget): Promise<number>;

  /**
   * An installation token for a target, from the cache while it has more
   * than the refresh margin left.
   */
  token(
    target: GithubAppTarget,
    options?: GithubAppTokenOptions,
  ): Promise<string>;

  /**
   * Every repository (`"owner/name"`) the App can reach, across all its
   * installations except suspended ones. Remembered for five minutes;
   * `refresh` reads it again, so an install made a moment ago works.
   */
  installedRepos(refresh?: boolean): Promise<string[]>;

  /**
   * Forgets every installation ID, token and the repository list.
   */
  forget(): void;
}

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const json64 = (value: object): string => {
  return base64url(encoder.encode(JSON.stringify(value)));
};

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
};

/**
 * DER length bytes.
 */
const derLength = (length: number): number[] => {
  if (length < 0x80) {
    return [length];
  }

  const bytes: number[] = [];

  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }

  return [0x80 | bytes.length, ...bytes];
};

const der = (tag: number, body: Uint8Array): Uint8Array => {
  const header = [tag, ...derLength(body.length)];
  const out = new Uint8Array(header.length + body.length);

  out.set(header);
  out.set(body, header.length);

  return out;
};

/**
 * Wraps a PKCS#1 RSA key as PKCS#8: a sequence of the version, the RSA
 * algorithm and the key as an octet string.
 */
const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array => {
  const version = der(0x02, new Uint8Array([0]));
  const algorithm = der(
    0x30,
    new Uint8Array([
      // rsaEncryption, 1.2.840.113549.1.1.1, and a null.
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05,
      0x00,
    ]),
  );
  const key = der(0x04, pkcs1);
  const body = new Uint8Array(version.length + algorithm.length + key.length);

  body.set(version);
  body.set(algorithm, version.length);
  body.set(key, version.length + algorithm.length);

  return der(0x30, body);
};

/**
 * The key as WebCrypto reads it, from either PEM form.
 */
const importKey = async (privateKey: string): Promise<CryptoKey> => {
  const pem = privateKey
    .replaceAll("\\n", "\n")
    .replaceAll("\r\n", "\n")
    .trim();
  const match =
    /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1PRIVATE KEY-----/.exec(
      pem,
    );

  if (!match) {
    throw new NonRetriableError(
      "githubApp: the private key is not a PEM (expected BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY)",
    );
  }

  const body = fromBase64((match[2] as string).replace(/\s+/g, ""));
  const pkcs8 = match[1] ? pkcs1ToPkcs8(body) : body;

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
};

const minute = 60_000;

/**
 * A listing that does not end after this many pages of 100 is not read to the
 * end silently: it fails.
 */
const maxPages = 100;

interface CachedToken {
  token: string;
  expires: number;
}

/**
 * EXPERIMENTAL: Authenticates as a GitHub App. Keep the result at module
 * scope: it holds the caches.
 */
export const githubApp = (options: GithubAppOptions): GithubApp => {
  if (!options?.appId || !options.privateKey?.trim()) {
    throw new NonRetriableError("githubApp: appId and privateKey are required");
  }

  const api = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch: typeof fetch =
    options.fetch ??
    ((input, init) => {
      return fetch(input, init);
    });
  const now = options.now ?? Date.now;
  const margin = options.refreshMarginMs ?? 5 * minute;
  const installations = new Map<string, number>();
  const tokens = new Map<string, CachedToken>();
  let key: Promise<CryptoKey> | undefined;
  let listed: { repos: string[]; at: number } | undefined;

  const jwt = async (): Promise<string> => {
    key ??= importKey(options.privateKey);

    const seconds = Math.floor(now() / 1000);
    const unsigned = `${json64({ alg: "RS256", typ: "JWT" })}.${json64({
      iat: seconds - 60,
      exp: seconds + 9 * 60,
      iss: options.appId,
    })}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await key,
      encoder.encode(unsigned),
    );

    return `${unsigned}.${base64url(new Uint8Array(signature))}`;
  };

  const request = async (
    path: string,
    init: { method?: string; auth: string; body?: unknown },
  ): Promise<Response> => {
    return doFetch(`${api}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${init.auth}`,
        accept: "application/vnd.github+json",
        "user-agent": options.userAgent ?? "inngest-github-app",
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  };

  const describe = (target: GithubAppTarget): string => {
    return typeof target === "string"
      ? target
      : "org" in target
        ? `the organization ${target.org}`
        : "user" in target
          ? `the user ${target.user}`
          : `installation ${target.installation}`;
  };

  const installationPath = (
    target: Exclude<GithubAppTarget, { installation: number }>,
  ): string => {
    return typeof target === "string"
      ? `/repos/${target}/installation`
      : "org" in target
        ? `/orgs/${target.org}/installation`
        : `/users/${target.user}/installation`;
  };

  const installationKey = (target: GithubAppTarget): string => {
    return typeof target === "object" && "installation" in target
      ? `${options.appId}/installations/${target.installation}`
      : `${options.appId}${installationPath(target)}`;
  };

  const installationId = async (target: GithubAppTarget): Promise<number> => {
    if (typeof target === "object" && "installation" in target) {
      return target.installation;
    }

    const path = installationPath(target);
    const cacheKey = installationKey(target);
    const known = installations.get(cacheKey);

    if (known !== undefined) {
      return known;
    }

    if (typeof target === "string" && !/^[^/\s]+\/[^/\s]+$/.test(target)) {
      throw new NonRetriableError(
        `githubApp: "${target}" is not a repository as owner/name`,
      );
    }

    const found = await request(path, { auth: await jwt() });

    if (!found.ok) {
      const message =
        found.status === 404
          ? `The GitHub App ${options.appId} is not installed on ${describe(target)} (404).`
          : `GitHub gave the App ${options.appId} no installation for ${describe(target)} (${found.status}).`;

      // Anything but a 404 (a 5xx, a rejected JWT) is a failure to retry, not
      // a missing install.
      throw found.status === 404
        ? new GithubAppNotInstalledError(message)
        : new GithubAppError(message, found.status);
    }

    const { id } = (await found.json()) as { id: number };

    installations.set(cacheKey, id);

    return id;
  };

  const mint = async (
    id: number,
    scope:
      | {
          permissions?: GithubAppTokenOptions["permissions"];
          repositories?: string[];
        }
      | undefined,
    label: string,
  ): Promise<CachedToken> => {
    const body = {
      ...(scope?.permissions && { permissions: scope.permissions }),
      ...(scope?.repositories && { repositories: scope.repositories }),
    };
    const made = await request(`/app/installations/${id}/access_tokens`, {
      method: "POST",
      auth: await jwt(),
      body: Object.keys(body).length > 0 ? body : undefined,
    });

    if (!made.ok) {
      throw new GithubAppError(
        `GitHub gave the App ${options.appId} no installation token for ${label} (${made.status}).`,
        made.status,
      );
    }

    const issued = (await made.json()) as { token: string; expires_at: string };

    return { token: issued.token, expires: Date.parse(issued.expires_at) };
  };

  /**
   * The repositories a token is narrowed to: those asked for, else the
   * repository of a repository target. Empty means all.
   */
  const narrowedFor = (
    target: GithubAppTarget,
    tokenOptions: GithubAppTokenOptions | undefined,
  ): string[] | undefined => {
    const asked = tokenOptions?.repositories;

    if (asked === "all") {
      return undefined;
    }

    if (asked && asked.length > 0) {
      return asked;
    }

    return typeof target === "string"
      ? [target.slice(target.indexOf("/") + 1)]
      : undefined;
  };

  const inFlight = new Map<string, Promise<string>>();

  const token = async (
    target: GithubAppTarget,
    tokenOptions?: GithubAppTokenOptions,
  ): Promise<string> => {
    const repositories = narrowedFor(target, tokenOptions);
    const scope = { permissions: tokenOptions?.permissions, repositories };

    // The same ask made twice at once is made once.
    const askKey = JSON.stringify([
      options.appId,
      typeof target === "string" ? target : target,
      Object.entries(scope.permissions ?? {}).sort(),
      [...(repositories ?? [])].sort(),
    ]);
    const pending = inFlight.get(askKey);

    if (pending) {
      return pending;
    }

    const run = (async () => {
      let id = await installationId(target);
      const cacheKey = JSON.stringify([
        options.appId,
        id,
        Object.entries(scope.permissions ?? {}).sort(),
        [...(repositories ?? [])].sort(),
      ]);
      const cached = tokens.get(cacheKey);

      if (cached && cached.expires - now() > margin) {
        return cached.token;
      }

      let made: CachedToken;

      try {
        made = await mint(id, scope, describe(target));
      } catch (error) {
        // An installation that was removed and made again has a new ID: look
        // it up once more, which says so if the App is gone.
        if (
          !(error instanceof GithubAppError) ||
          error.status !== 404 ||
          (typeof target === "object" && "installation" in target)
        ) {
          throw error;
        }

        installations.delete(installationKey(target));
        id = await installationId(target);
        made = await mint(id, scope, describe(target));
      }

      tokens.set(cacheKey, made);

      return made.token;
    })();

    inFlight.set(askKey, run);

    try {
      return await run;
    } finally {
      inFlight.delete(askKey);
    }
  };

  const installedRepos = async (refresh = false): Promise<string[]> => {
    if (!refresh && listed && now() - listed.at < 5 * minute) {
      return listed.repos;
    }

    const found: { id: number; suspended_at?: string | null }[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const res = await request(
        `/app/installations?per_page=100&page=${page}`,
        { auth: await jwt() },
      );

      if (!res.ok) {
        throw new GithubAppError(
          `GitHub gave no installations for the App (${res.status}).`,
          res.status,
        );
      }

      const batch = (await res.json()) as typeof found;

      found.push(...batch);

      if (batch.length < 100) {
        break;
      }
    }

    const repos: string[] = [];

    for (const installation of found) {
      // A suspended installation has no token and no access; the others
      // still count.
      if (installation.suspended_at) {
        continue;
      }

      const { token: installationToken } = await mint(
        installation.id,
        undefined,
        `installation ${installation.id}`,
      );

      for (let page = 1; page <= maxPages; page++) {
        const res = await request(
          `/installation/repositories?per_page=100&page=${page}`,
          { auth: installationToken },
        );

        if (!res.ok) {
          throw new GithubAppError(
            `GitHub gave no repositories for an installation (${res.status}).`,
            res.status,
          );
        }

        const batch = (
          (await res.json()) as { repositories: { full_name: string }[] }
        ).repositories;

        repos.push(
          ...batch.map((repository) => {
            return repository.full_name;
          }),
        );

        if (batch.length < 100) {
          break;
        }
      }
    }

    listed = { repos, at: now() };

    return repos;
  };

  return {
    jwt,
    installationId,
    token,
    installedRepos,
    forget: () => {
      installations.clear();
      tokens.clear();
      listed = undefined;
    },
  };
};
