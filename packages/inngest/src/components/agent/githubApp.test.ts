/**
 * @module
 * Tests for the GitHub App helper against a fake GitHub API: the JWT is
 * checked with the public key, installations are found and remembered, tokens
 * are narrowed, cached and refreshed before they expire.
 */
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  GithubAppError,
  GithubAppNotInstalledError,
  githubApp,
} from "./githubApp.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = pair.privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;
const pkcs8 = pair.privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const publicKey = pair.publicKey;

const decode = (part: string) => {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
};

/**
 * A fake GitHub: records requests, answers installations and tokens.
 */
const fakeGithub = (
  options: {
    installed?: Record<string, number>;
    suspended?: number[];
    repositories?: Record<number, string[]>;
    expiresInMs?: number;
    now?: () => number;
  } = {},
) => {
  const requests: {
    method: string;
    path: string;
    auth: string;
    body?: unknown;
  }[] = [];
  let issued = 0;
  const now = options.now ?? Date.now;

  const fetchFake = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string>;
    const auth = headers.authorization?.replace("Bearer ", "") ?? "";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname + url.search;

    requests.push({ method, path, auth, body });

    const installation =
      /^\/(repos\/[^/]+\/[^/]+|orgs\/[^/]+|users\/[^/]+)\/installation$/.exec(
        url.pathname,
      );

    if (installation) {
      const id = options.installed?.[installation[1] as string];

      return id === undefined
        ? new Response("{}", { status: 404 })
        : Response.json({ id });
    }

    if (url.pathname === "/app/installations") {
      const ids = Object.keys(options.repositories ?? {}).map(Number);

      return Response.json(
        ids.map((id) => {
          return {
            id,
            suspended_at: options.suspended?.includes(id) ? "2026-01-01" : null,
          };
        }),
      );
    }

    const minted = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(
      url.pathname,
    );

    if (minted) {
      issued += 1;

      return Response.json({
        token: `ghs_${minted[1]}_${issued}`,
        expires_at: new Date(
          now() + (options.expiresInMs ?? 3_600_000),
        ).toISOString(),
      });
    }

    if (url.pathname === "/installation/repositories") {
      const id = Number(auth.split("_")[1]);

      return Response.json({
        repositories: (options.repositories?.[id] ?? []).map((full_name) => {
          return { full_name };
        }),
      });
    }

    return new Response("{}", { status: 500 });
  };

  return { fetch: fetchFake as typeof fetch, requests };
};

describe("jwt", () => {
  for (const [name, privateKey] of [
    ["PKCS#8", pkcs8],
    ["PKCS#1", pkcs1],
    ["a PEM with newlines escaped", pkcs8.replaceAll("\n", "\\n")],
  ] as const) {
    test(`is RS256, short-lived and signed by the key (${name})`, async () => {
      const at = 1_700_000_000_000;
      const app = githubApp({ appId: "123", privateKey, now: () => at });
      const [head, claims, signature] = (await app.jwt()).split(".") as [
        string,
        string,
        string,
      ];

      expect(decode(head)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(decode(claims)).toEqual({
        iat: at / 1000 - 60,
        exp: at / 1000 + 540,
        iss: "123",
      });
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${head}.${claims}`),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
    });
  }

  test("refuses a key that is not a PEM, and a missing id or key", async () => {
    await expect(
      githubApp({ appId: "1", privateKey: "nope" }).jwt(),
    ).rejects.toThrow("not a PEM");
    expect(() => githubApp({ appId: "", privateKey: pkcs8 })).toThrow(
      "required",
    );
    expect(() => githubApp({ appId: "1", privateKey: " " })).toThrow(
      "required",
    );
  });
});

describe("installations and tokens", () => {
  test("finds the installation of a repo, an org and a user, and remembers it", async () => {
    const github = fakeGithub({
      installed: { "repos/acme/app": 11, "orgs/acme": 12, "users/jack": 13 },
    });
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: github.fetch,
    });

    expect(await app.installationId("acme/app")).toBe(11);
    expect(await app.installationId("acme/app")).toBe(11);
    expect(await app.installationId({ org: "acme" })).toBe(12);
    expect(await app.installationId({ user: "jack" })).toBe(13);
    expect(await app.installationId({ installation: 99 })).toBe(99);

    expect(
      github.requests.filter((r) => {
        return r.path.endsWith("/installation");
      }),
    ).toHaveLength(3);
  });

  test("the lookup is signed by the App and the token request by the App too", async () => {
    const github = fakeGithub({ installed: { "repos/acme/app": 11 } });
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: github.fetch,
    });
    const token = await app.token("acme/app");

    expect(token).toBe("ghs_11_1");
    expect(github.requests.map((r) => [r.method, r.path])).toEqual([
      ["GET", "/repos/acme/app/installation"],
      ["POST", "/app/installations/11/access_tokens"],
    ]);

    for (const request of github.requests) {
      const [head, claims, signature] = request.auth.split(".") as [
        string,
        string,
        string,
      ];

      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${head}.${claims}`),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
    }
  });

  test("a token is narrowed to the permissions and repositories asked for", async () => {
    const github = fakeGithub({ installed: { "orgs/acme": 12 } });
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: github.fetch,
    });

    await app.token(
      { org: "acme" },
      { permissions: { contents: "write" }, repositories: ["website"] },
    );

    expect(github.requests.at(-1)?.body).toEqual({
      permissions: { contents: "write" },
      repositories: ["website"],
    });
  });

  test("tokens are cached per installation and scope, and refreshed before they expire", async () => {
    let at = 1_700_000_000_000;
    const github = fakeGithub({
      installed: { "repos/acme/app": 11 },
      expiresInMs: 3_600_000,
      now: () => at,
    });
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: github.fetch,
      now: () => at,
    });
    const mints = () => {
      return github.requests.filter((r) => {
        return r.method === "POST";
      }).length;
    };

    const first = await app.token("acme/app");

    expect(await app.token("acme/app")).toBe(first);
    expect(mints()).toBe(1);

    // A different scope is its own token.
    const narrow = await app.token("acme/app", {
      permissions: { contents: "read" },
    });

    expect(narrow).not.toBe(first);
    expect(mints()).toBe(2);

    // Still good with more than five minutes left.
    at += 3_600_000 - 6 * 60_000;
    expect(await app.token("acme/app")).toBe(first);

    // Within five minutes of expiry it is minted again.
    at += 2 * 60_000;

    const refreshed = await app.token("acme/app");

    expect(refreshed).not.toBe(first);
    expect(mints()).toBe(3);
  });

  test("a repo the App is not on is a not-installed error, and any other failure is a plain one", async () => {
    const github = fakeGithub({});
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: github.fetch,
    });

    await expect(app.token("acme/nope")).rejects.toBeInstanceOf(
      GithubAppNotInstalledError,
    );

    const broken = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: (async () => {
        return new Response("{}", { status: 502 });
      }) as typeof fetch,
    });
    const error = await broken.token("acme/app").catch((e) => e);

    expect(error).toBeInstanceOf(GithubAppError);
    expect(error).not.toBeInstanceOf(GithubAppNotInstalledError);
    expect(error.status).toBe(502);

    const minting = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: (async (input: RequestInfo | URL) => {
        return String(input).endsWith("/installation")
          ? Response.json({ id: 1 })
          : new Response("{}", { status: 403 });
      }) as typeof fetch,
    });

    await expect(minting.token("acme/app")).rejects.toThrow(
      "no installation token",
    );
  });

  test("a token for a repository is narrowed to it unless all is asked for", async () => {
    const github = fakeGithub({ installed: { "repos/acme/app": 11 } });
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: github.fetch,
    });
    const bodies = () => {
      return github.requests
        .filter((r) => {
          return r.method === "POST";
        })
        .map((r) => {
          return r.body;
        });
    };

    await app.token("acme/app");
    await app.token("acme/app", { repositories: [] });
    await app.token("acme/app", { repositories: "all" });
    await app.token("acme/app", { repositories: ["app", "other"] });

    // The empty list is the default again, so it is the same token.
    expect(bodies()).toEqual([
      { repositories: ["app"] },
      undefined,
      { repositories: ["app", "other"] },
    ]);
  });

  test("the same token asked for at once is minted once", async () => {
    const github = fakeGithub({ installed: { "repos/acme/app": 11 } });
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: github.fetch,
    });
    const tokens = await Promise.all([
      app.token("acme/app"),
      app.token("acme/app"),
      app.token("acme/app"),
    ]);

    expect(new Set(tokens).size).toBe(1);
    expect(
      github.requests.filter((r) => {
        return r.method === "POST";
      }),
    ).toHaveLength(1);
  });

  test("an installation that was made again is found again, and one that is gone is not installed", async () => {
    let id = 11;
    let gone = false;
    const github = fakeGithub({ installed: {} });
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));

        if (url.pathname.endsWith("/installation")) {
          return gone
            ? new Response("{}", { status: 404 })
            : Response.json({ id });
        }

        // The old installation no longer exists.
        if (
          url.pathname === "/app/installations/11/access_tokens" &&
          id !== 11
        ) {
          return new Response("{}", { status: 404 });
        }

        return github.fetch(input, init);
      }) as typeof fetch,
    });

    expect(await app.installationId("acme/app")).toBe(11);

    id = 22;
    expect(await app.token("acme/app")).toMatch(/^ghs_22_/);

    id = 33;
    gone = true;
    app.forget();
    await app.installationId({ installation: 22 });
    await expect(app.token("acme/app")).rejects.toBeInstanceOf(
      GithubAppNotInstalledError,
    );
  });

  test("the PEM labels must agree", async () => {
    const body = pkcs8.replace(/-----[A-Z ]+-----/g, "").trim();
    const mixed = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;

    await expect(
      githubApp({ appId: "1", privateKey: mixed }).jwt(),
    ).rejects.toThrow("not a PEM");
  });

  test("a repository must be owner/name", async () => {
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: fakeGithub().fetch,
    });

    await expect(app.token("just-a-name")).rejects.toThrow("owner/name");
  });

  test("forget drops the remembered installations and tokens", async () => {
    const github = fakeGithub({ installed: { "repos/acme/app": 11 } });
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: github.fetch,
    });

    await app.token("acme/app");
    app.forget();
    await app.token("acme/app");

    expect(
      github.requests.filter((r) => {
        return r.path.endsWith("/installation");
      }),
    ).toHaveLength(2);
  });

  test("the API base URL and user agent are configurable", async () => {
    let seen = "";
    let agent = "";
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      apiUrl: "https://ghe.test/api/v3/",
      userAgent: "my-bot",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = String(input);
        agent = (init?.headers as Record<string, string>)[
          "user-agent"
        ] as string;

        return Response.json({ id: 1 });
      }) as typeof fetch,
    });

    await app.installationId("acme/app");

    expect(seen).toBe("https://ghe.test/api/v3/repos/acme/app/installation");
    expect(agent).toBe("my-bot");
  });
});

describe("installedRepos", () => {
  test("lists the repositories of every installation except suspended ones, and remembers them for five minutes", async () => {
    let at = 1_700_000_000_000;
    const github = fakeGithub({
      repositories: {
        11: ["acme/a", "acme/b"],
        12: ["other/c"],
        13: ["gone/d"],
      },
      suspended: [13],
      now: () => at,
    });
    const app = githubApp({
      appId: "1",
      privateKey: pkcs8,
      fetch: github.fetch,
      now: () => at,
    });

    expect(await app.installedRepos()).toEqual(["acme/a", "acme/b", "other/c"]);

    const calls = github.requests.length;

    expect(await app.installedRepos()).toEqual(["acme/a", "acme/b", "other/c"]);
    expect(github.requests).toHaveLength(calls);

    expect(await app.installedRepos(true)).toHaveLength(3);
    expect(github.requests.length).toBeGreaterThan(calls);

    at += 6 * 60_000;
    await app.installedRepos();
    expect(github.requests.length).toBeGreaterThan(calls * 2 - 1);
  });
});
