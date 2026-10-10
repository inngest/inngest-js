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

const secret = "ghs_never_in_a_trace";

const nightly = { name: "test/nightly", data: {} };

/** A CI client whose GitHub calls go to a fake, with the given provider. */
const setup = (
  provider: (gh: ReturnType<typeof createFakeGitHub>) => GitHubProvider = (
    gh,
  ) => {
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
const platform = (
  gh: ReturnType<typeof createFakeGitHub>,
  sha = "cafe1234",
) => {
  gh.route("GET /repos/acme/platform", { default_branch: "main" });

  gh.route("GET /repos/acme/platform/commits/main", { sha });

  gh.route("GET /repos/acme/platform/commits/v2", { sha: "beef5678" });
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

describe("checkout() of another repository", () => {
  test("clones the commit the default branch resolves to", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const build = ci.job("build", async () => {
      await checkout({ repo: "acme/platform" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: prEvent },
    );

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
  });

  test("keeps the installation token out of every step", async () => {
    const { gh, ci } = setup();

    platform(gh);

    const build = ci.job("build", async () => {
      await checkout({ repo: "acme/platform", ref: "v2" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect(JSON.stringify(result.steps)).not.toContain(secret);
    expect(JSON.stringify(result.metadata)).not.toContain(secret);
  });

  test("resolves a ref to a commit once per run", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const first = ci.job("first", async () => {
      await checkout({ repo: "acme/platform", ref: "main" });
    });

    const second = ci.job("second", async () => {
      await checkout({ repo: "acme/platform", ref: "main", path: "/other" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await Promise.all([first(), second()]);
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    expect(
      result.stepIds.filter((id) => {
        return id.startsWith("github › ref:");
      }),
    ).toEqual(["github › ref:acme/platform@main"]);

    expect(
      gh.requests.filter((request) => {
        return request.path === "/repos/acme/platform/commits/main";
      }),
    ).toHaveLength(1);

    expect(cloneScripts(api)).toHaveLength(2);
  });

  test("works when the run's trigger has no repository", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const build = ci.job("build", async () => {
      await checkout({ repo: "acme/platform", ref: "main" });
    });

    const result = await runFunction(
      ci.pipeline(
        { id: "nightly", on: [{ event: "test/nightly" }], check: false },
        async () => {
          return build();
        },
      ),
      { event: nightly },
    );

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");
  });

  test("still needs a repository when none is given", async () => {
    const { ci } = setup();

    const build = ci.job("build", async () => {
      await checkout();
    });

    const result = await runFunction(
      ci.pipeline(
        { id: "nightly", on: [{ event: "test/nightly" }], check: false },
        async () => {
          return build();
        },
      ),
      { event: nightly },
    );

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain("needs a repository");
  });

  test("a ref alone overrides the run's commit for its own repository", async () => {
    const { api, gh, ci } = setup();

    gh.route("GET /repos/inngest/inngest-js", { default_branch: "main" });

    gh.route("GET /repos/inngest/inngest-js/commits/release", {
      sha: "feed9999",
    });

    const build = ci.job("build", async () => {
      await checkout({ ref: "release" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'feed9999'");
  });

  test("a ref that doesn't exist is named in the error", async () => {
    const { gh, ci } = setup();

    platform(gh);

    gh.route("GET /repos/acme/platform/commits/nope", {}, 422);

    const build = ci.job("build", async () => {
      await checkout({ repo: "acme/platform", ref: "nope" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain("`nope`");
    expect(JSON.stringify(result.error)).toContain("acme/platform");
  });
});

describe("one commit per repository per run", () => {
  test("repo alone and repo with the default branch share one resolve step", async () => {
    const { gh, ci } = setup();

    platform(gh);

    const first = ci.job("first", async () => {
      await checkout({ repo: "acme/platform" });
    });

    const second = ci.job("second", async () => {
      await checkout({ repo: "acme/platform", ref: "main", path: "/other" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await Promise.all([first(), second()]);
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    expect(
      result.stepIds.filter((id) => {
        return id.startsWith("github › ref:");
      }),
    ).toEqual(["github › ref:acme/platform@main"]);

    expect(
      gh.requests.filter((request) => {
        return request.path === "/repos/acme/platform/commits/main";
      }),
    ).toHaveLength(1);

    expect(result.steps["build › checkout"]).toBeUndefined();
    expect(result.steps["first › checkout"]).toMatchObject({ sha: "cafe1234" });
    expect(result.steps["second › checkout"]).toMatchObject({
      sha: "cafe1234",
    });
  });

  test("a long ref keeps the step ID bounded", async () => {
    const { gh, ci } = setup();
    const ref = "x".repeat(600);

    platform(gh);

    gh.route(`GET /repos/acme/platform/commits/${ref}`, { sha: "aaaa0000" });

    const build = ci.job("build", async () => {
      await checkout({ repo: "acme/platform", ref });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    for (const id of result.stepIds) {
      expect(id.length).toBeLessThanOrEqual(255);
    }
  });
});

describe("what a failed lookup says", () => {
  const failed = async (
    prepare: (gh: ReturnType<typeof createFakeGitHub>) => void,
    opts: { repo: string; ref?: string } = { repo: "acme/platform" },
    provider?: Parameters<typeof setup>[0],
  ) => {
    const { ci, gh } = setup(provider);

    prepare(gh);

    const build = ci.job("build", async () => {
      await checkout(opts);
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-rejected");

    return JSON.stringify(result.error);
  };

  test("no ref and no default branch says so, not undefined", async () => {
    const message = await failed((gh) => {
      gh.route("GET /repos/acme/platform", {});
    });

    expect(message).toContain("the default branch");
    expect(message).not.toContain("undefined");
  });

  test("an empty repository is called empty", async () => {
    const message = await failed((gh) => {
      gh.route("GET /repos/acme/platform", { default_branch: "main" });

      gh.route(
        "GET /repos/acme/platform/commits/main",
        { message: "Git Repository is empty." },
        409,
      );
    });

    expect(message).toContain("the repository is empty");
  });

  test("the token provider says the token, not the GitHub App", async () => {
    const message = await failed((gh) => {
      gh.route("GET /repos/acme/platform", { message: "Not Found" }, 404);
    });

    expect(message).toContain("The token can't access");
    expect(message).not.toContain("GitHub App");
  });

  test.each([
    "acme",
    "acme/platform/extra",
    "-acme/platform",
    "ac me/platform",
    "acme/plat form",
    "acme/..",
    "acme/.",
    "acme/pla\ttform",
    "ac_me/platform",
  ])("rejects the repo %j", async (repo) => {
    const message = await failed(() => {}, { repo });

    expect(message).toContain("`repo` must be");
  });
});

describe("a truncated tree", () => {
  test("throws instead of hashing part of the files", async () => {
    const { gh, ci } = setup();

    platform(gh);

    gh.route("GET /repos/acme/platform/git/trees/cafe1234", {
      truncated: true,
      tree: [{ type: "blob", path: "a", sha: "1" }],
    });

    const image = ci.job(
      {
        id: "image",
        cache: { key: files("**", { repo: "acme/platform" }) },
      },
      async () => {
        await $`build image`;
      },
    );

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return image();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);

    const message = JSON.stringify(result.error);

    expect(message).toContain("too large to hash");
    expect(message).toContain("narrower patterns");
  });
});

describe("the clone", () => {
  test("keeps the token out of the clone script and commands", async () => {
    const { api, gh, ci } = setup();

    platform(gh);

    const build = ci.job("build", async () => {
      await checkout({ repo: "acme/platform" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    const script = cloneScripts(api)[0] ?? "";

    expect(script).not.toContain(secret);
    expect(JSON.stringify(api.commands)).not.toContain(secret);
  });

  test("fetches a fork's pull request head when the repo's case differs", async () => {
    const { api, gh, ci } = setup();

    gh.route("GET /repos/INNGEST/Inngest-JS/commits/abc1234", {
      sha: "abc1234",
    });

    const build = ci.job("build", async () => {
      await checkout({ repo: "INNGEST/Inngest-JS", ref: "abc1234" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      {
        event: {
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
      },
    );

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("fetch origin 'refs/pull/7/head'");
  });
});

describe("the GitHub App's installation", () => {
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;

  const app = (gh: ReturnType<typeof createFakeGitHub>) => {
    return githubApp({
      appId: "123",
      privateKey: key,
      baseUrl: "https://api.github.test",
      fetch: gh.fetch,
    });
  };

  const tokenRoutes = (gh: ReturnType<typeof createFakeGitHub>) => {
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

  const requestsOf = (gh: ReturnType<typeof createFakeGitHub>) => {
    return gh.requests.map((request) => {
      return `${request.method} ${request.path}`;
    });
  };

  const checkoutPlatform = async (
    ci: ReturnType<typeof setup>["ci"],
    opts: { repo: string } = { repo: "acme/platform" },
  ) => {
    const build = ci.job("build", async () => {
      await checkout(opts);
    });

    return runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: prEvent },
    );
  };

  test("the run's own installation is used first", async () => {
    const { api, gh, ci } = setup(app);

    platform(gh);
    tokenRoutes(gh);

    const result = await checkoutPlatform(ci);

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

    await checkoutPlatform(ci);

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

    gh.handle("GET /repos/acme/platform", (request) => {
      return request.authorization?.includes("tok_run")
        ? { body: { message: "Not Found" }, status: 404 }
        : { body: { default_branch: "main" } };
    });

    gh.handle("GET /repos/acme/platform/commits/main", (request) => {
      return request.authorization?.includes("tok_run")
        ? { body: { message: "Not Found" }, status: 404 }
        : { body: { sha: "cafe1234" } };
    });

    const result = await checkoutPlatform(ci);

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

    const result = await checkoutPlatform(ci, { repo: "acme/secret" });

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

    gh.handle("GET /repos/acme/platform", () => {
      return {
        body: { message: "API rate limit exceeded" },
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "retry-after": "1" },
      };
    });

    const result = await checkoutPlatform(ci);

    expect(result.type).toBe("function-rejected");

    const message = JSON.stringify(result.error);

    expect(message).toContain("rate limit");
    expect(message).not.toContain("can't access");

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

    gh.handle("GET /repos/acme/platform/installation", () => {
      return {
        body: { message: "API rate limit exceeded" },
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      };
    });

    const result = await checkoutPlatform(ci);

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

    const result = await checkoutPlatform(ci);

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);
    expect(JSON.stringify(result.error)).toContain("credentials");
  });
});

describe("files() of another repository or ref", () => {
  const tree = (sha: string) => {
    return {
      tree: [
        { type: "blob", path: "images/node-base/Dockerfile", sha },
        { type: "blob", path: "README.md", sha: "ignored" },
      ],
    };
  };

  /** Names of the cached snapshots after one run with the given tree. */
  const cachedNames = async (
    base: string,
    opts: { ref?: string } = {},
  ): Promise<{ names: string[]; paths: string[] }> => {
    const { api, gh, ci } = setup();

    platform(gh, "cafe1234");

    gh.route("GET /repos/acme/platform/git/trees/cafe1234", tree(base));

    const image = ci.job(
      {
        id: "image",
        cache: {
          key: files("images/node-base/**", {
            repo: "acme/platform",
            ...opts,
          }),
        },
      },
      async () => {
        await $`build image`;
      },
    );

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return image();
      }),
      { event: prEvent },
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
    const { paths } = await cachedNames("blob1", { ref: "main" });

    expect(paths).toContain("/repos/acme/platform/git/trees/cafe1234");
    expect(paths).not.toContain("/repos/acme/platform/git/trees/main");
  });

  test("the key changes when the commit's matched files change", async () => {
    const before = await cachedNames("blob1", { ref: "main" });
    const same = await cachedNames("blob1", { ref: "main" });
    const after = await cachedNames("blob2", { ref: "main" });

    expect(before.names).toHaveLength(1);
    expect(same.names).toEqual(before.names);
    expect(after.names).not.toEqual(before.names);
  });

  test("defaults the ref to the repository's default branch", async () => {
    const { paths } = await cachedNames("blob1");

    expect(paths).toContain("/repos/acme/platform/commits/main");
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

  test("uploads the working tree without options", async () => {
    const { api, gh, ci } = setup();
    const event = localEvent();

    const build = ci.job("build", async () => {
      await checkout();

      await checkout({ repo: "inngest/inngest-js" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event },
    );

    expect(result.type).toBe("function-resolved");
    expect(result.steps["build › checkout"]).toMatchObject({ source: "local" });
    expect(cloneScripts(api)).toHaveLength(0);
    expect(gh.requests).toHaveLength(0);
  });

  test("clones from GitHub for another repository", async () => {
    const { api, gh, ci } = setup();
    const event = localEvent();

    platform(gh);

    const build = ci.job("build", async () => {
      await checkout({ repo: "acme/platform" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event },
    );

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");
  });

  test("clones from GitHub for an explicit ref", async () => {
    const { api, gh, ci } = setup();
    const event = localEvent();

    gh.route("GET /repos/inngest/inngest-js", { default_branch: "main" });

    gh.route("GET /repos/inngest/inngest-js/commits/release", {
      sha: "feed9999",
    });

    const build = ci.job("build", async () => {
      await checkout({ ref: "release" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event },
    );

    expect(result.type).toBe("function-resolved");
    expect(cloneScripts(api)[0]).toContain("checkout 'feed9999'");
  });
});
