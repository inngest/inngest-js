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
import { CiUsageError } from "../errors.ts";
import { $ } from "../machine/command.ts";
import { createCi } from "../pipeline/createCi.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeGitHub } from "../testing/fakeGitHub.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import type { GitHubProvider } from "./auth.ts";
import { githubApp, githubToken } from "./auth.ts";
import { settledSources } from "./source.ts";

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

/** Make `acme/platform`'s default branch and `main` and `v2` resolve to commits. */
const platform = (gh: FakeGitHub, sha = "cafe1234") => {
  gh.route("GET /repos/acme/platform/commits/HEAD", { sha });

  gh.route("GET /repos/acme/platform/commits/main", { sha });

  gh.route("GET /repos/acme/platform/commits/v2", { sha: "beef5678" });
};

/** Make a repository look missing to whoever asks, as GitHub does for no access. */
const hidden = (gh: FakeGitHub, fullName: string) => {
  gh.route(`GET /repos/${fullName}`, { message: "Not Found" }, 404);

  gh.route(
    `GET /repos/${fullName}/commits/HEAD`,
    { message: "Not Found" },
    404,
  );
};

/** Make `ref` of the run's own repository resolve to a commit. */
const ownRepo = (gh: FakeGitHub, ref: string, sha: string) => {
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
  opts: Record<string, Checkout>,
  event: typeof prEvent | typeof nightly = prEvent,
) => {
  const jobs = Object.entries(opts).map(([id, each]) => {
    return ci.job(id, async () => {
      await checkout(each);
    });
  });

  const options =
    event === nightly
      ? {
          id: "nightly",
          on: [{ event: "test/nightly" }],
          check: false as const,
        }
      : { id: "pr", on: prTrigger, childRuns: false };

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

const requestsTo = (gh: FakeGitHub, path: string) => {
  return gh.requests.filter((request) => {
    return request.path === path;
  });
};

describe("checkout() of another repository", () => {
  test("clones the commit the default branch resolves to, without the token in any step", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const result = await checkingOut(ci, { build: { repo: "acme/platform" } });

    expect(result.type).toBe("function-resolved");
    expect(result.stepIds).toContain("github › ref:acme/platform@HEAD");
    expect(result.stepIds).toContain("build › checkout");

    expect(cloneScripts(api)).toHaveLength(1);
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");

    expect(result.steps["build › checkout"]).toMatchObject({
      sha: "cafe1234",
      source: "github",
    });

    for (const seen of [result.steps, result.metadata, api.commands]) {
      expect(JSON.stringify(seen)).not.toContain(secret);
    }
  });

  test.each([
    { ref: "main", step: "main", path: "commits/main" },
    { ref: undefined, step: "HEAD", path: "commits/HEAD" },
  ])(
    "resolves ref $ref to a commit once per run",
    async ({ ref, step, path }) => {
      const { api, gh, ci } = setup();

      platform(gh);

      const opts = { repo: "acme/platform", ...(ref ? { ref } : {}) };

      const result = await checkingOut(ci, {
        first: opts,
        second: { ...opts, path: "/other" },
      });

      expect(result.type).toBe("function-resolved");
      expect(refSteps(result.stepIds)).toEqual([
        `github › ref:acme/platform@${step}`,
      ]);
      expect(requestsTo(gh, `/repos/acme/platform/${path}`)).toHaveLength(1);
      expect(cloneScripts(api)).toHaveLength(2);
    },
  );

  test.each([
    {
      name: "works when the run's trigger has no repository",
      routes: platform,
      opts: { repo: "acme/platform", ref: "main" },
      event: nightly,
      sha: "cafe1234",
    },
    {
      name: "a ref alone overrides the run's commit for its own repository",
      routes: (gh: FakeGitHub) => {
        ownRepo(gh, "release", "feed9999");
      },
      opts: { ref: "release" },
      event: prEvent,
      sha: "feed9999",
    },
  ])("$name", async ({ routes, opts, event, sha }) => {
    const { api, gh, ci } = setup();

    routes(gh);

    const result = await checkingOut(ci, { build: opts }, event);

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain(`checkout '${sha}'`);
  });

  test("still needs a repository when none is given", async () => {
    const { ci } = setup();

    const result = await checkingOut(ci, { build: {} }, nightly);

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain("needs a repository");
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
        gh.route("GET /repos/acme/platform/commits/HEAD", {}, 404);
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
          "GET /repos/acme/platform/commits/HEAD",
          { message: "Git Repository is empty." },
          409,
        );
      },
      contains: ["the repository is empty"],
    },
    {
      name: "the token provider says the token, not the GitHub App",
      routes: (gh) => {
        hidden(gh, "acme/platform");
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

  test("the run's own installation is used first, with a token narrowed to the repository", async () => {
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

    for (const request of gh.requests) {
      if (request.path.endsWith("/access_tokens")) {
        expect(request.body).toMatchObject({ repositories: ["platform"] });
      }
    }
  });

  test.each([
    {
      name: "the run's installation can't see the repository",
      routes: (gh: FakeGitHub) => {
        gh.handle("GET /repos/acme/platform*", (request) => {
          return request.authorization?.includes("tok_run")
            ? { body: { message: "Not Found" }, status: 404 }
            : { body: { sha: "cafe1234" } };
        });
      },
    },
    {
      name: "the narrowed token is refused",
      routes: (gh: FakeGitHub) => {
        platform(gh);

        gh.route(
          "POST /app/installations/1/access_tokens",
          { message: "Validation Failed" },
          422,
        );
      },
    },
  ])("is found from the repository when $name", async ({ routes }) => {
    const { api, gh, ci } = setup(app);

    tokenRoutes(gh);

    routes(gh);

    gh.route("GET /repos/acme/platform/installation", { id: 99 });

    const result = await checkoutRepo(ci);

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");

    const paths = requestsOf(gh);

    expect(paths).toContain("GET /repos/acme/platform/installation");
    expect(paths).toContain("POST /app/installations/99/access_tokens");

    expect(result.steps["github › ref:acme/platform@HEAD"]).toMatchObject({
      installationId: 99,
      sha: "cafe1234",
    });

    expect(JSON.stringify(result.steps)).not.toContain(secret);
  });

  test.each([
    {
      name: "an app that can't access the repository says so",
      repo: "acme/secret",
      routes: (gh: FakeGitHub) => {
        hidden(gh, "acme/secret");

        gh.route(
          "GET /repos/acme/secret/installation",
          { message: "Not Found" },
          404,
        );
      },
      retriable: false,
      contains: ["acme/secret", "GitHub App"],
    },
    {
      name: "a rate limit reading the repository retries instead of reading as no access",
      routes: (gh: FakeGitHub) => {
        gh.handle(
          "GET /repos/acme/platform/commits/HEAD",
          rateLimited({ "retry-after": "1" }),
        );
      },
      contains: ["rate limit"],
      excludes: ["can't access"],
    },
    {
      name: "a rate limit looking up the installation retries too",
      routes: (gh: FakeGitHub) => {
        hidden(gh, "acme/platform");

        gh.handle("GET /repos/acme/platform/installation", rateLimited({}));
      },
      contains: ["rate limit"],
      excludes: ["can't access"],
    },
    {
      name: "a rejected App says its credentials are the problem",
      routes: (gh: FakeGitHub) => {
        hidden(gh, "acme/platform");

        gh.route(
          "GET /repos/acme/platform/installation",
          { message: "Bad credentials" },
          401,
        );
      },
      retriable: false,
      contains: ["credentials"],
    },
  ])(
    "$name",
    async ({
      repo = "acme/platform",
      routes,
      retriable,
      contains,
      excludes = [],
    }) => {
      const { api, gh, ci } = setup(app);

      tokenRoutes(gh);

      routes(gh);

      const result = await checkoutRepo(ci, repo);

      expect(result.type).toBe("function-rejected");

      if (retriable !== undefined) {
        expect(result.retriable).toBe(retriable);
      }

      const message = JSON.stringify(result.error);

      for (const text of contains) {
        expect(message).toContain(text);
      }

      for (const text of excludes) {
        expect(message).not.toContain(text);
      }

      expect(cloneScripts(api)).toHaveLength(0);
    },
  );
});

describe("files() of another repository or ref", () => {
  /** A job cached on `files()`, in a run of its own. */
  const runImage = (ci: Ci, part: ReturnType<typeof files>) => {
    const image = ci.job({ id: "image", cache: { key: part } }, async () => {
      await $`build image`;
    });

    return runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, childRuns: false }, async () => {
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

  test.each([
    { ref: "main", resolved: "commits/main" },
    { ref: undefined, resolved: "commits/HEAD" },
  ])(
    "reads the tree of the commit ref $ref resolves to, not the ref name",
    async ({ ref, resolved }) => {
      const { paths } = await cachedNames("blob1", ref);

      expect(paths).toContain(`/repos/acme/platform/${resolved}`);
      expect(paths).toContain("/repos/acme/platform/git/trees/cafe1234");
      expect(paths).not.toContain("/repos/acme/platform/git/trees/main");
    },
  );

  test("the key changes when the commit's matched files change", async () => {
    const before = await cachedNames("blob1", "main");
    const same = await cachedNames("blob1", "main");
    const after = await cachedNames("blob2", "main");

    expect(before.names).toHaveLength(1);
    expect(same.names).toEqual(before.names);
    expect(after.names).not.toEqual(before.names);
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
    expect(message).toContain("Key the job on a string");
  });

  test.each([
    ["", false],
    ["acme", false],
    ["acme/platform/extra", false],
    ["acme/..", false],
    ["ac me/platform", false],
    ["octo_cat/platform", true],
  ])("the part's repo %j is valid: %s", (repo, valid) => {
    const define = () => {
      return files("a", { repo });
    };

    if (valid) {
      expect(define).not.toThrow();
    } else {
      expect(define).toThrow(CiUsageError);
    }
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
      ci.pipeline({ id: "pr", on: prTrigger, childRuns: false }, async () => {
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

    expect(cloneScripts(api)).toHaveLength(0);
    expect(gh.requests).toHaveLength(0);
  });

  test.each([
    {
      name: "another repository",
      routes: platform,
      opts: { repo: "acme/platform" },
      sha: "cafe1234",
    },
    {
      name: "an explicit ref",
      routes: (gh: FakeGitHub) => {
        ownRepo(gh, "release", "feed9999");
      },
      opts: { ref: "release" },
      sha: "feed9999",
    },
  ])("clones from GitHub for $name", async ({ routes, opts, sha }) => {
    const { api, gh, ci } = setup();

    routes(gh);

    const result = await runLocal(ci, [opts]);

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain(`checkout '${sha}'`);
  });
});

describe("the sources handed to a build run", () => {
  test("keeps what resolved and leaves out what failed", async () => {
    const source = {
      owner: "acme",
      name: "platform",
      fullName: "acme/platform",
      sha: "abc",
    };
    const failed = Promise.reject(new Error("no access"));

    const settled = await settledSources({
      sources: new Map([
        ["acme/platform@main", Promise.resolve(source)],
        ["acme/other@HEAD", failed],
      ]),
    } as unknown as Parameters<typeof settledSources>[0]);

    expect(settled).toEqual({ "acme/platform@main": source });
  });

  test("a build reads the commit the invoker keyed on after the branch moves", async () => {
    const { gh, ci } = setup();

    let lookups = 0;

    gh.handle("GET /repos/acme/platform/commits/main", () => {
      lookups++;

      return { body: { sha: lookups === 1 ? "cafe1234" : "beef5678" } };
    });

    gh.route("GET /repos/acme/platform/git/trees/cafe1234", {
      tree: [{ type: "blob", path: "a", sha: "old" }],
    });

    gh.route("GET /repos/acme/platform/git/trees/beef5678", {
      tree: [{ type: "blob", path: "a", sha: "new" }],
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, childRuns: false }, async () => {
        const image = ci.job(
          {
            id: "image",
            cache: { key: files("a", { repo: "acme/platform", ref: "main" }) },
          },
          async () => {
            await $`build image`;
          },
        );

        return image();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect(lookups).toBe(1);
  });
});
