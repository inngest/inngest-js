/**
 * @module
 * EXPERIMENTAL: a git remote served over HTTP that wants a token (the real
 * `git http-backend` behind a basic-auth check), to test an agent's pushes.
 * It needs `git` with `git-http-backend` installed.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { asyncDispose } from "../../../helpers/asyncDispose.ts";

let found: { path: string | undefined } | undefined;

/**
 * The path of `git-http-backend`, or `undefined` when git does not have it.
 * Looked up on first use, not when the module loads.
 */
export const backendPath = (): string | undefined => {
  if (!found) {
    try {
      const path = join(
        execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
        "git-http-backend",
      );
      execFileSync(path, ["--help"], { stdio: "ignore" });
      found = { path };
    } catch {
      found = { path: undefined };
    }
  }

  return found.path;
};

/**
 * Runs `git` in `cwd` with a fixed author and no user config, and returns
 * its trimmed output.
 */
const git = (cwd: string, ...args: string[]): string => {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
};

/**
 * The files of a commit, by path.
 */
export type GitFiles = Record<string, string>;

/**
 * What a repository starts with: the files of its `main` branch, or branches
 * by name (`main` first; every other branch starts from `main`).
 */
export type GitSeed = GitFiles | Record<string, GitFiles>;

/**
 * Options of `startGitRemote()`.
 */
export interface GitRemoteOptions {
  /**
   * The token a push needs: basic auth as `x-access-token:<token>`.
   */
  token: string;

  /**
   * The repositories served, by name (`<name>.git`), each with its seed.
   * Default: one repository called `repo` with a README and `src/a.ts` on
   * `main`.
   */
  repos?: Record<string, GitSeed>;

  /**
   * Whether fetching and cloning need no token, as for a public repository.
   * A push always needs it. Default: `false`, the token is needed for every
   * request.
   */
  anonymousReads?: boolean;
}

/**
 * One repository of the remote.
 */
export interface GitRepo {
  /**
   * The HTTP URL, without credentials.
   */
  url: string;

  /**
   * The bare repository on disk.
   */
  dir: string;

  /**
   * The commit each seeded branch pointed at when the remote started.
   */
  heads: Record<string, string>;
}

/**
 * A running git remote.
 */
export interface GitRemote {
  /**
   * The HTTP URL of the first repository, without credentials.
   */
  url: string;

  /**
   * The bare repository of the first repository on disk.
   */
  dir: string;

  /**
   * Every repository, by name.
   */
  repos: Record<string, GitRepo>;

  /**
   * Basic-auth headers the server has seen, to show what reached it.
   */
  seen: string[];

  /**
   * The authorization header of each push (`git-receive-pack`) request.
   */
  pushAuth: string[];

  /**
   * Stops the server and removes the repositories from disk.
   */
  close: () => Promise<void>;

  /**
   * Same as `close()`, for `await using remote = await startGitRemote(...)`.
   */
  [Symbol.asyncDispose]: () => Promise<void>;
}

const defaultSeed: GitFiles = {
  "README.md": "hello\n",
  "src/a.ts": "export const a = 1;\n",
};

const isFiles = (seed: GitSeed): seed is GitFiles => {
  return Object.values(seed).every((value) => {
    return typeof value === "string";
  });
};

const seedRepo = (bare: string, seed: GitSeed): Record<string, string> => {
  const branches: Record<string, GitFiles> = isFiles(seed)
    ? { main: seed }
    : seed;
  const work = `${bare}.seed`;
  const heads: Record<string, string> = {};

  mkdirSync(work, { recursive: true });
  git(work, "init", "--quiet", "-b", "main");

  // `main` is always there, empty when the seed does not name it, and every
  // other branch starts from it.
  const ordered: [string, GitFiles][] = [
    ["main", branches.main ?? {}],
    ...Object.entries(branches).filter(([branch]) => {
      return branch !== "main";
    }),
  ];

  for (const [branch, files] of ordered) {
    git(
      work,
      "checkout",
      "--quiet",
      "-B",
      branch,
      ...(branch === "main" ? [] : ["main"]),
    );

    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    }

    git(work, "add", ".");
    git(work, "commit", "--quiet", "--allow-empty", "-m", `seed ${branch}`);
    heads[branch] = git(work, "rev-parse", "HEAD");
    git(work, "push", "--quiet", bare, branch);
  }

  return heads;
};

/**
 * Starts bare repositories served over HTTP by the real `git http-backend`.
 * A push needs `x-access-token:<token>`; so does everything else unless
 * `anonymousReads` is on. Pass a token alone for one default repository.
 */
export const startGitRemote = async (
  options: GitRemoteOptions | string,
): Promise<GitRemote> => {
  const {
    token,
    repos = { repo: defaultSeed },
    anonymousReads = false,
  } = typeof options === "string" ? { token: options } : options;
  const backend = backendPath();

  if (Object.keys(repos).length === 0) {
    throw new Error("startGitRemote needs at least one repository in `repos`.");
  }

  if (!backend) {
    throw new Error("git http-backend is not available");
  }

  const root = mkdtempSync(join(tmpdir(), "git-remote-"));
  const served: Record<string, { dir: string; heads: Record<string, string> }> =
    {};

  try {
    for (const [name, seed] of Object.entries(repos)) {
      const dir = join(root, `${name}.git`);

      git(root, "init", "--bare", "--quiet", "-b", "main", dir);
      git(dir, "config", "http.receivepack", "true");
      git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
      served[name] = { dir, heads: seedRepo(dir, seed) };
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });

    throw error;
  }

  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const seen: string[] = [];
  const pushAuth: string[] = [];
  const running = new Set<ReturnType<typeof spawn>>();
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");

    const url = new URL(req.url ?? "/", "http://localhost");
    // A push is the receive-pack request and the discovery that asks for it.
    const pushing =
      url.pathname.endsWith("/git-receive-pack") ||
      url.searchParams.get("service") === "git-receive-pack";

    if (pushing) {
      pushAuth.push(req.headers.authorization ?? "");
    }

    if (
      req.headers.authorization !== expected &&
      (pushing || !anonymousReads)
    ) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      res.end();

      return;
    }

    let pathInfo: string;

    try {
      pathInfo = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      res.end();

      return;
    }

    const child = spawn(backend, [], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: pathInfo,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        ...(req.headers["content-length"] && {
          CONTENT_LENGTH: req.headers["content-length"],
        }),
        ...(req.headers["content-encoding"] && {
          HTTP_CONTENT_ENCODING: req.headers["content-encoding"],
        }),
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const chunks: Buffer[] = [];

    running.add(child);
    // The backend can exit before it has read the request, and it can fail to
    // start: neither may crash the test or leave the request unanswered.
    child.stdin.on("error", () => {});
    child.on("error", () => {
      running.delete(child);

      if (!res.headersSent) {
        res.writeHead(500);
      }

      res.end();
    });
    req.pipe(child.stdin);
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("close", () => {
      running.delete(child);

      if (res.writableEnded) {
        return;
      }

      const out = Buffer.concat(chunks);
      const split = out.indexOf("\r\n\r\n");

      // The backend died before it answered (it was killed, or it crashed).
      if (split < 0) {
        res.writeHead(502);
        res.end();

        return;
      }

      const head = out.subarray(0, split).toString().split("\r\n");
      const headers: Record<string, string> = {};
      let status = 200;

      for (const line of head) {
        const [name = "", ...rest] = line.split(": ");

        if (name.toLowerCase() === "status") {
          status = Number.parseInt(rest.join(": "), 10);
        } else {
          headers[name] = rest.join(": ");
        }
      }

      res.writeHead(status, headers);
      res.end(out.subarray(split + 4));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  const close = async () => {
    for (const child of running) {
      child.kill("SIGKILL");
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  };

  const byName = Object.fromEntries(
    Object.entries(served).map(([name, repo]) => {
      return [
        name,
        {
          url: `http://127.0.0.1:${port}/${encodeURIComponent(name)}.git`,
          dir: repo.dir,
          heads: repo.heads,
        },
      ];
    }),
  );
  const first = Object.values(byName)[0] as GitRepo;

  return {
    url: first.url,
    dir: first.dir,
    repos: byName,
    seen,
    pushAuth,
    close,
    [asyncDispose]: close,
  };
};
