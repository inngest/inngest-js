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
    expect(result.stepIds).toContain("github › ref:acme/platform@");
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

  test("is found from the repository, not the run", async () => {
    const { api, gh, ci } = setup(app);

    platform(gh);

    gh.route("GET /repos/acme/platform/installation", { id: 99 });

    gh.route("POST /app/installations/99/access_tokens", {
      token: secret,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

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
    expect(cloneScripts(api)[0]).toContain("checkout 'cafe1234'");

    const paths = gh.requests.map((request) => {
      return `${request.method} ${request.path}`;
    });

    expect(paths).toContain("GET /repos/acme/platform/installation");
    expect(paths).toContain("POST /app/installations/99/access_tokens");
    expect(paths).not.toContain("POST /app/installations/1/access_tokens");

    expect(result.steps["github › ref:acme/platform@"]).toMatchObject({
      installationId: 99,
      sha: "cafe1234",
    });

    expect(JSON.stringify(result.steps)).not.toContain(secret);
  });

  test("an app that can't access the repository says so", async () => {
    const { api, gh, ci } = setup(app);

    gh.route(
      "GET /repos/acme/secret/installation",
      { message: "Not Found" },
      404,
    );

    const build = ci.job("build", async () => {
      await checkout({ repo: "acme/secret" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);

    const message = JSON.stringify(result.error);

    expect(message).toContain("acme/secret");
    expect(message).toContain("GitHub App");

    expect(cloneScripts(api)).toHaveLength(0);
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
