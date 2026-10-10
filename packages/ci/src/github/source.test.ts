/**
 * Tests for `checkout()` and `files()` reading another repository or ref: the
 * ref is resolved to a commit once, the commit is what's cloned and keyed, the
 * installation is found for the repository, and the local working tree is only
 * left for the run's own repository.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { files } from "../cache/cache.ts";
import { checkout } from "../checkout/checkout.ts";
import { $ } from "../machine/command.ts";
import { createCi } from "../pipeline/createCi.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeGitHub } from "../testing/fakeGitHub.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import type { GitHubProvider } from "./auth.ts";
import { githubApp, githubToken } from "./auth.ts";

type FakeGitHub = ReturnType<typeof createFakeGitHub>;

type Ci = ReturnType<typeof setup>["ci"];

const secret = "ghs_never_in_a_trace";

const nightly = { name: "test/nightly", data: {} };

/** A CI client whose GitHub calls go to a fake, with the given provider. */
const setup = (
  provider: (gh: FakeGitHub) => GitHubProvider = (gh) => {
    return githubToken({
      token: secret,
      baseUrl: "https://api.github.test",
      fetch: gh.fetch,
    });
  },
) => {
  const api = createFakeSandboxApi();
  const gh = createFakeGitHub();

  const ci = createCi(createCiTestClient(api), {
    github: { ...provider(gh), reporter: "statuses" },
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  return { api, gh, ci };
};

/** Make `acme/platform`'s `main` branch resolve to a commit. */
const platform = (gh: FakeGitHub, sha = "cafe1234") => {
  gh.route("GET /repos/acme/platform", { default_branch: "main" });

  gh.route("GET /repos/acme/platform/commits/main", { sha });

  gh.route("GET /repos/acme/platform/commits/v2", { sha: "beef5678" });
};

/** Make `ref` of the run's own repository resolve to a commit. */
const ownRepo = (gh: FakeGitHub, ref: string, sha: string) => {
  gh.route("GET /repos/inngest/inngest-js", { default_branch: "main" });

  gh.route(`GET /repos/inngest/inngest-js/commits/${ref}`, { sha });
};

const cloneScripts = (api: ReturnType<typeof createFakeSandboxApi>) => {
  return api.commands
    .map((argv) => {
      return argv[2] ?? "";
    })
    .filter((script) => {
      return script.includes("git clone");
    });
};

type Checkout = Parameters<typeof checkout>[0];

/**
 * Run jobs that each call `checkout()` with their own options, side by side,
 * in a pull request run or, with no repository in the trigger, a cron.
 */
const checkingOut = (
  ci: Ci,
  jobs: Record<string, Checkout>,
  event: typeof prEvent | typeof nightly = prEvent,
) => {
  return running(
    ci,
    Object.fromEntries(
      Object.entries(jobs).map(([id, opts]) => {
        return [
          id,
          async () => {
            await checkout(opts);
          },
        ];
      }),
    ),
    event,
  );
};

/** Run jobs side by side in a pull request run or a cron. */
const running = (
  ci: Ci,
  bodies: Record<string, () => Promise<void>>,
  event: typeof prEvent | typeof nightly = prEvent,
) => {
  const jobs = Object.entries(bodies).map(([id, body]) => {
    return ci.job(id, body);
  });

  const options =
    event === nightly
      ? {
          id: "nightly",
          on: [{ event: "test/nightly" }],
          check: false as const,
        }
      : { id: "pr", on: prTrigger };

  return runFunction(
    ci.pipeline(options, async () => {
      await Promise.all(
        jobs.map((job) => {
          return job();
        }),
      );
    }),
    { event },
  );
};

const refSteps = (stepIds: string[]) => {
  return stepIds.filter((id) => {
    return id.startsWith("github › ref:");
  });
};

/** What each step says it set out to do, by step ID. */
const intents = (metadata: Awaited<ReturnType<typeof running>>["metadata"]) => {
  return Object.fromEntries(
    metadata.map((update) => {
      return [update.step, update.values.intent];
    }),
  );
};

const requestsTo = (gh: FakeGitHub, path: string) => {
  return gh.requests.filter((request) => {
    return request.path === path;
  });
};

describe("checkout() of another repository", () => {
  test("clones the commit the default branch resolves to", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const result = await checkingOut(ci, { build: { repo: "acme/platform" } });

    expect(result.type).toBe("function-resolved");
    expect(result.stepIds).toContain("github › default-branch:acme/platform");
    expect(result.stepIds).toContain("github › ref:acme/platform@main");
    expect(result.stepIds).toContain("build › checkout");

    expect(cloneScripts(api)).toHaveLength(1);
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");
    expect(cloneScripts(api)[0]).not.toContain(secret);

    expect(result.steps["build › checkout"]).toMatchObject({
      sha: "cafe1234",
      source: "github",
    });

    expect(intents(result.metadata)).toMatchObject({
      "github › default-branch:acme/platform":
        "Find the default branch of `acme/platform`",
      "github › ref:acme/platform@main":
        "Resolve `main` of `acme/platform` to a commit",
      "build › checkout": "Clone `acme/platform` into `/work`",
    });
  });

  test("keeps the installation token out of every step", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const result = await checkingOut(ci, {
      build: { repo: "acme/platform", ref: "v2" },
    });

    expect(result.type).toBe("function-resolved");
    expect(JSON.stringify(result.steps)).not.toContain(secret);
    expect(JSON.stringify(result.metadata)).not.toContain(secret);
    expect(JSON.stringify(api.commands)).not.toContain(secret);
  });

  test("resolves a ref to a commit once per run", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const result = await checkingOut(ci, {
      first: { repo: "acme/platform", ref: "main" },
      second: { repo: "acme/platform", ref: "main", path: "/other" },
    });

    expect(result.type).toBe("function-resolved");
    expect(refSteps(result.stepIds)).toEqual([
      "github › ref:acme/platform@main",
    ]);
    expect(requestsTo(gh, "/repos/acme/platform/commits/main")).toHaveLength(1);
    expect(cloneScripts(api)).toHaveLength(2);
  });

  test("repo alone and repo with the default branch share one resolve step", async () => {
    const { gh, ci } = setup();

    platform(gh);

    const result = await checkingOut(ci, {
      first: { repo: "acme/platform" },
      second: { repo: "acme/platform", ref: "main", path: "/other" },
    });

    expect(result.type).toBe("function-resolved");
    expect(refSteps(result.stepIds)).toEqual([
      "github › ref:acme/platform@main",
    ]);
    expect(requestsTo(gh, "/repos/acme/platform/commits/main")).toHaveLength(1);
    expect(result.steps["first › checkout"]).toMatchObject({ sha: "cafe1234" });
    expect(result.steps["second › checkout"]).toMatchObject({
      sha: "cafe1234",
    });
  });

  test("works when the run's trigger has no repository", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const result = await checkingOut(
      ci,
      { build: { repo: "acme/platform", ref: "main" } },
      nightly,
    );

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");
  });

  test("still needs a repository when none is given", async () => {
    const { ci } = setup();

    const result = await checkingOut(ci, { build: {} }, nightly);

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain("needs a repository");
  });

  test("a ref alone overrides the run's commit for its own repository", async () => {
    const { api, gh, ci } = setup();

    ownRepo(gh, "release", "feed9999");

    const result = await checkingOut(ci, { build: { ref: "release" } });

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'feed9999'");
  });

  test("a long ref keeps the step ID bounded", async () => {
    const { gh, ci } = setup();
    const ref = "x".repeat(600);

    platform(gh);

    gh.route(`GET /repos/acme/platform/commits/${ref}`, { sha: "aaaa0000" });

    const result = await checkingOut(ci, {
      build: { repo: "acme/platform", ref },
    });

    expect(result.type).toBe("function-resolved");

    for (const id of result.stepIds) {
      expect(id.length).toBeLessThanOrEqual(255);
    }
  });

  test("fetches a fork's pull request head when the repo's case differs", async () => {
    const { api, gh, ci } = setup();

    gh.route("GET /repos/INNGEST/Inngest-JS/commits/abc1234", {
      sha: "abc1234",
    });

    const result = await checkingOut(
      ci,
      { build: { repo: "INNGEST/Inngest-JS", ref: "abc1234" } },
      {
        ...prEvent,
        data: {
          ...prEvent.data,
          pull_request: {
            ...prEvent.data.pull_request,
            head: {
              ...prEvent.data.pull_request.head,
              repo: { full_name: "someone/inngest-js" },
            },
          },
        },
      },
    );

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("fetch origin 'refs/pull/7/head'");
  });
});

describe("what a failed lookup says", () => {
  const cases: {
    name: string;
    routes?: (gh: FakeGitHub) => void;
    opts?: Checkout;
    provider?: Parameters<typeof setup>[0];
    contains: string[];
    excludes?: string[];
  }[] = [
    {
      name: "a ref that doesn't exist is named",
      routes: (gh) => {
        platform(gh);

        gh.route("GET /repos/acme/platform/commits/nope", {}, 422);
      },
      opts: { repo: "acme/platform", ref: "nope" },
      contains: ["`nope`", "acme/platform"],
    },
    {
      name: "no default branch says so, not undefined",
      routes: (gh) => {
        gh.route("GET /repos/acme/platform", {});
      },
      contains: ["the default branch"],
      excludes: ["undefined"],
    },
    {
      name: "an empty repository is called empty",
      routes: (gh) => {
        platform(gh);

        gh.route(
          "GET /repos/acme/platform/commits/main",
          { message: "Git Repository is empty." },
          409,
        );
      },
      contains: ["the repository is empty"],
    },
    {
      name: "the token provider says the token, not the GitHub App",
      routes: (gh) => {
        gh.route("GET /repos/acme/platform", { message: "Not Found" }, 404);
      },
      contains: ["The token can't access"],
      excludes: ["GitHub App"],
    },
    ...[
      "acme",
      "acme/platform/extra",
      "-acme/platform",
      "ac me/platform",
      "acme/plat form",
      "acme/..",
      "acme/.",
      "acme/pla\ttform",
      "ac_me/platform",
    ].map((repo) => {
      return {
        name: `the repo ${JSON.stringify(repo)} is rejected`,
        opts: { repo },
        contains: ["`repo` must be"],
      };
    }),
  ];

  test.each(cases)(
    "$name",
    async ({
      routes,
      opts = { repo: "acme/platform" },
      provider,
      contains,
      excludes = [],
    }) => {
      const { ci, gh } = setup(provider);

      routes?.(gh);

      const result = await checkingOut(ci, { build: opts });

      expect(result.type).toBe("function-rejected");

      const message = JSON.stringify(result.error);

      for (const text of contains) {
        expect(message).toContain(text);
      }

      for (const text of excludes) {
        expect(message).not.toContain(text);
      }
    },
  );
});

describe("the GitHub App's installation", () => {
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;

  const app = (gh: FakeGitHub) => {
    return githubApp({
      appId: "123",
      privateKey: key,
      baseUrl: "https://api.github.test",
      fetch: gh.fetch,
    });
  };

  const tokenRoutes = (gh: FakeGitHub) => {
    const expires = new Date(Date.now() + 3600_000).toISOString();

    gh.route("POST /app/installations/1/access_tokens", {
      token: "tok_run",
      expires_at: expires,
    });

    gh.route("POST /app/installations/99/access_tokens", {
      token: secret,
      expires_at: expires,
    });
  };

  const requestsOf = (gh: FakeGitHub) => {
    return gh.requests.map((request) => {
      return `${request.method} ${request.path}`;
    });
  };

  /** Answer as the other installation would, and 404 for the run's own. */
  const onlyInstallation99 = (gh: FakeGitHub, path: string, body: unknown) => {
    gh.handle(`GET ${path}`, (request) => {
      return request.authorization?.includes("tok_run")
        ? { body: { message: "Not Found" }, status: 404 }
        : { body };
    });
  };

  const rateLimited = (headers: Record<string, string>) => {
    return () => {
      return {
        body: { message: "API rate limit exceeded" },
        status: 403,
        headers: { "x-ratelimit-remaining": "0", ...headers },
      };
    };
  };

  const checkoutRepo = (ci: Ci, repo = "acme/platform") => {
    return checkingOut(ci, { build: { repo } });
  };

  test("the run's own installation is used first", async () => {
    const { api, gh, ci } = setup(app);

    platform(gh);
    tokenRoutes(gh);

    const result = await checkoutRepo(ci);

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");

    const paths = requestsOf(gh);

    expect(paths).toContain("POST /app/installations/1/access_tokens");
    expect(paths).not.toContain("GET /repos/acme/platform/installation");
    expect(paths).not.toContain("POST /app/installations/99/access_tokens");
  });

  test("tokens are narrowed to the one repository", async () => {
    const { gh, ci } = setup(app);

    platform(gh);
    tokenRoutes(gh);

    await checkoutRepo(ci);

    const minted = gh.requests.filter((request) => {
      return (
        request.method === "POST" && request.path.endsWith("/access_tokens")
      );
    });

    expect(minted.length).toBeGreaterThan(0);

    for (const request of minted) {
      expect(request.body).toMatchObject({ repositories: ["platform"] });
    }
  });

  test("is found from the repository when the run's can't see it", async () => {
    const { api, gh, ci } = setup(app);

    tokenRoutes(gh);

    gh.route("GET /repos/acme/platform/installation", { id: 99 });

    onlyInstallation99(gh, "/repos/acme/platform", { default_branch: "main" });

    onlyInstallation99(gh, "/repos/acme/platform/commits/main", {
      sha: "cafe1234",
    });

    const result = await checkoutRepo(ci);

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");

    const paths = requestsOf(gh);

    expect(paths).toContain("GET /repos/acme/platform/installation");
    expect(paths).toContain("POST /app/installations/99/access_tokens");

    expect(result.steps["github › ref:acme/platform@main"]).toMatchObject({
      installationId: 99,
      sha: "cafe1234",
    });

    expect(JSON.stringify(result.steps)).not.toContain(secret);
  });

  test("an app that can't access the repository says so", async () => {
    const { api, gh, ci } = setup(app);

    tokenRoutes(gh);

    gh.route("GET /repos/acme/secret", { message: "Not Found" }, 404);

    gh.route(
      "GET /repos/acme/secret/installation",
      { message: "Not Found" },
      404,
    );

    const result = await checkoutRepo(ci, "acme/secret");

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);

    const message = JSON.stringify(result.error);

    expect(message).toContain("acme/secret");
    expect(message).toContain("GitHub App");

    expect(cloneScripts(api)).toHaveLength(0);
  });

  test("a rate limit retries instead of reading as no access", async () => {
    const { gh, ci } = setup(app);

    tokenRoutes(gh);

    gh.handle("GET /repos/acme/platform", rateLimited({ "retry-after": "1" }));

    const result = await checkoutRepo(ci);

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain("rate limit");
    expect(JSON.stringify(result.error)).not.toContain("can't access");

    expect(
      requestsOf(gh).filter((path) => {
        return path === "GET /repos/acme/platform";
      }).length,
    ).toBeGreaterThan(1);
  });

  test("a rate limit looking up the installation retries too", async () => {
    const { gh, ci } = setup(app);

    tokenRoutes(gh);

    gh.route("GET /repos/acme/platform", { message: "Not Found" }, 404);

    gh.handle("GET /repos/acme/platform/installation", rateLimited({}));

    const result = await checkoutRepo(ci);

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain("rate limit");
    expect(JSON.stringify(result.error)).not.toContain("can't access");
  });

  test("a rejected App says its credentials are the problem", async () => {
    const { gh, ci } = setup(app);

    tokenRoutes(gh);

    gh.route("GET /repos/acme/platform", { message: "Not Found" }, 404);

    gh.route(
      "GET /repos/acme/platform/installation",
      { message: "Bad credentials" },
      401,
    );

    const result = await checkoutRepo(ci);

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);
    expect(JSON.stringify(result.error)).toContain("credentials");
  });
});

describe("files() of another repository or ref", () => {
  /** A job cached on `files()`, in a run of its own. */
  const runImage = (ci: Ci, part: ReturnType<typeof files>) => {
    const image = ci.job({ id: "image", cache: { key: part } }, async () => {
      await $`build image`;
    });

    return runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return image();
      }),
      { event: prEvent },
    );
  };

  /** Names of the cached snapshots after one run with the given tree. */
  const cachedNames = async (base: string, ref?: string) => {
    const { api, gh, ci } = setup();

    platform(gh);

    gh.route("GET /repos/acme/platform/git/trees/cafe1234", {
      tree: [
        { type: "blob", path: "images/node-base/Dockerfile", sha: base },
        { type: "blob", path: "README.md", sha: "ignored" },
      ],
    });

    const result = await runImage(
      ci,
      files("images/node-base/**", {
        repo: "acme/platform",
        ...(ref ? { ref } : {}),
      }),
    );

    expect(result.type).toBe("function-resolved");

    return {
      names: [...api.snapshots.values()].flatMap((snapshot) => {
        return snapshot.name ? [snapshot.name] : [];
      }),
      paths: gh.requests.map((request) => {
        return request.path;
      }),
    };
  };

  test("reads the tree of the resolved commit, not the ref name", async () => {
    const { paths } = await cachedNames("blob1", "main");

    expect(paths).toContain("/repos/acme/platform/git/trees/cafe1234");
    expect(paths).not.toContain("/repos/acme/platform/git/trees/main");
  });

  test("the key changes when the commit's matched files change", async () => {
    const before = await cachedNames("blob1", "main");
    const same = await cachedNames("blob1", "main");
    const after = await cachedNames("blob2", "main");

    expect(before.names).toHaveLength(1);
    expect(same.names).toEqual(before.names);
    expect(after.names).not.toEqual(before.names);
  });

  test("defaults the ref to the repository's default branch", async () => {
    const { paths } = await cachedNames("blob1");

    expect(paths).toContain("/repos/acme/platform/commits/main");
  });

  test("a truncated tree throws instead of hashing part of the files", async () => {
    const { gh, ci } = setup();

    platform(gh);

    gh.route("GET /repos/acme/platform/git/trees/cafe1234", {
      truncated: true,
      tree: [{ type: "blob", path: "a", sha: "1" }],
    });

    const result = await runImage(ci, files("**", { repo: "acme/platform" }));

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);

    const message = JSON.stringify(result.error);

    expect(message).toContain("too large to hash");
    expect(message).toContain("narrower patterns");
  });

  test("keeps the part's own options", () => {
    expect(files("a", "b", { repo: "acme/platform", ref: "main" })).toEqual({
      kind: "inngest/ci.cacheKeyPart",
      type: "files",
      patterns: ["a", "b"],
      repo: "acme/platform",
      ref: "main",
    });

    expect(files("a")).toEqual({
      kind: "inngest/ci.cacheKeyPart",
      type: "files",
      patterns: ["a"],
    });
  });
});

describe("a local run", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }

    dir = undefined;
  });

  const localEvent = () => {
    dir = mkdtempSync(join(tmpdir(), "inngest-ci-source-"));

    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });

    writeFileSync(join(dir, "a.txt"), "a");

    return {
      ...prEvent,
      data: { ...prEvent.data, local: { path: dir, baseRef: "main" } },
    };
  };

  const runLocal = (ci: Ci, opts: Checkout[]) => {
    const build = ci.job("build", async () => {
      for (const each of opts) {
        await checkout(each);
      }
    });

    return runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: localEvent() },
    );
  };

  test("uploads the working tree without options", async () => {
    const { api, gh, ci } = setup();

    const result = await runLocal(ci, [{}, { repo: "inngest/inngest-js" }]);

    expect(result.type).toBe("function-resolved");
    expect(result.steps["build › checkout"]).toMatchObject({ source: "local" });

    expect(intents(result.metadata)["build › checkout"]).toBe(
      "Upload the working tree to `/work`",
    );
    expect(cloneScripts(api)).toHaveLength(0);
    expect(gh.requests).toHaveLength(0);
  });

  test("clones from GitHub for another repository", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const result = await runLocal(ci, [{ repo: "acme/platform" }]);

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");
  });

  test("clones from GitHub for an explicit ref", async () => {
    const { api, gh, ci } = setup();

    ownRepo(gh, "release", "feed9999");

    const result = await runLocal(ci, [{ ref: "release" }]);

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'feed9999'");
  });
});
