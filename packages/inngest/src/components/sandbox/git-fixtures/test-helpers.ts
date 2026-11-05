/**
 * @module
 * Fixtures for the git push tests: a git remote served over HTTP that wants a
 * token (the real `git http-backend` behind a basic-auth check), and a
 * sandbox that runs its commands on this machine.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Sandbox } from "../types.ts";

export const backendPath = ((): string | undefined => {
  try {
    const path = join(
      execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
      "git-http-backend",
    );
    execFileSync(path, ["--help"], { stdio: "ignore" });

    return path;
  } catch {
    return undefined;
  }
})();

export const git = (cwd: string, ...args: string[]): string => {
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

export interface GitRemote {
  /**
   * The HTTP URL of the repository, without credentials.
   */
  url: string;

  /**
   * The bare repository on disk.
   */
  dir: string;

  /**
   * Basic-auth headers the server has seen, to show what reached it.
   */
  seen: string[];
  close: () => Promise<void>;
}

/**
 * A bare repository with one commit on `main`, served over HTTP for
 * `x-access-token:<token>` only.
 */
export const startGitRemote = async (token: string): Promise<GitRemote> => {
  if (!backendPath) {
    throw new Error("git http-backend is not available");
  }

  const backend = backendPath;
  const root = mkdtempSync(join(tmpdir(), "git-remote-"));
  const dir = join(root, "repo.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--quiet", "-b", "main", dir);
  git(dir, "config", "http.receivepack", "true");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "-b", "main");
  mkdirSync(join(seed, "src"));
  writeFileSync(join(seed, "README.md"), "hello\n");
  writeFileSync(join(seed, "src", "a.ts"), "export const a = 1;\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", dir, "main");

  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      res.end();

      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const child = spawn(backend, [], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: url.pathname,
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

    req.pipe(child.stdin);
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("close", () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf("\r\n\r\n");
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

  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    dir,
    seen,
    close: () => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
};

/**
 * A sandbox whose commands and files are on this machine: enough of the
 * interface for a shim handler.
 */
export const localSandbox = (): Sandbox => {
  const sandbox = {
    id: "local",
    commands: {
      run: (
        argv: string[],
        options?: { cwd?: string },
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        return new Promise((resolve) => {
          execFile(
            argv[0] as string,
            argv.slice(1),
            {
              cwd: options?.cwd,
              encoding: "utf8",
              maxBuffer: 64 * 1024 * 1024,
              env: {
                ...process.env,
                GIT_AUTHOR_NAME: "t",
                GIT_AUTHOR_EMAIL: "t@example.com",
                GIT_COMMITTER_NAME: "t",
                GIT_COMMITTER_EMAIL: "t@example.com",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_TERMINAL_PROMPT: "0",
              },
            },
            (error, stdout, stderr) => {
              resolve({
                exitCode:
                  error === null
                    ? 0
                    : typeof error.code === "number"
                      ? error.code
                      : 1,
                stdout,
                stderr,
              });
            },
          );
        });
      },
    },
    files: {
      upload: async ({ path, data }: { path: string; data: BodyInit }) => {
        mkdirSync(dirname(path), { recursive: true });
        const bytes = new Uint8Array(await new Response(data).arrayBuffer());
        writeFileSync(path, bytes);

        return { path, bytesWritten: bytes.byteLength };
      },
      download: async ({ path }: { path: string }) => {
        return new Response(readFileSync(path));
      },
    },
  };

  return sandbox as unknown as Sandbox;
};
