/**
 * @module
 * A GitHub Git Data API in memory, for the tests of the git-free push: blobs,
 * trees, commits and refs, with the hashes git gives them, so a commit rebuilt
 * through the API has the same SHA as the commit in the repository it came
 * from. `seed()` loads a commit of a real repository as the remote's state.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { git } from "./test-helpers.ts";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export const blobSha = (bytes: Uint8Array): string => {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
};

interface Entry {
  mode: string;
  sha: string;
}

const hash = (type: string, body: Buffer): string => {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${body.length}\0`))
    .update(body)
    .digest("hex");
};

/**
 * The SHA git gives a tree of files at flat paths, built the way git builds it.
 */
const treeSha = (files: Map<string, Entry>, prefix = ""): string => {
  const level = new Map<string, "file" | "dir">();

  for (const path of files.keys()) {
    const rest = path.slice(prefix.length);

    if (path.startsWith(prefix)) {
      const [first = "", ...more] = rest.split("/");

      level.set(first, more.length > 0 ? "dir" : "file");
    }
  }

  const parts = [...level]
    .map(([name, kind]) => {
      const sort = kind === "dir" ? `${name}/` : name;

      return { name, kind, sort };
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  const body = parts.map(({ name, kind }) => {
    const entry = files.get(`${prefix}${name}`);
    const mode = kind === "dir" ? "40000" : (entry?.mode as string);
    const sha =
      kind === "dir"
        ? treeSha(files, `${prefix}${name}/`)
        : (entry?.sha as string);

    return Buffer.concat([
      Buffer.from(`${mode} ${name}\0`),
      Buffer.from(sha, "hex"),
    ]);
  });

  return hash("tree", Buffer.concat(body));
};

/**
 * The seconds and zone git writes for an ISO date.
 */
const gitDate = (iso: string): string => {
  const zone = /([+-])(\d\d):(\d\d)$/.exec(iso);

  return `${Math.floor(Date.parse(iso) / 1000)} ${zone ? `${zone[1]}${zone[2]}${zone[3]}` : "+0000"}`;
};

/**
 * A GitHub API in memory: the endpoints a push uses, and a record of the
 * requests it saw.
 */
/**
 * The size above which the contents API stops inlining a file's content.
 */
const inlineLimit = 1024 * 1024;

export const fakeGitHub = () => {
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Map<string, Entry>>();
  const commits = new Map<
    string,
    { tree: string; parents: string[]; message: string; author: unknown }
  >();
  const refs = new Map<string, string>();
  const requests: { method: string; path: string; authorization?: string }[] =
    [];
  const fail: {
    match?: RegExp;
    status: number;
    headers?: Record<string, string>;
    before?: () => void;
  } = { status: 0 };
  /**
   * Makes the contents API report this size for a file, to stand in for a big one.
   */
  const reported = new Map<string, number>();

  const ancestors = (sha: string): Set<string> => {
    const seen = new Set<string>();
    const walk = [sha];

    for (let next = walk.pop(); next !== undefined; next = walk.pop()) {
      if (!seen.has(next)) {
        seen.add(next);
        walk.push(...(commits.get(next)?.parents ?? []));
      }
    }

    return seen;
  };

  const respond = (data: unknown, status = 200): Response => {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  const handle: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/repos/acme/app", "") || "/";
    const headers = init?.headers as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    requests.push({ method, path, authorization: headers.authorization });

    if (fail.match?.test(`${method} ${path}`)) {
      fail.before?.();

      const failed = respond(
        { message: `boom ${headers.authorization}` },
        fail.status,
      );

      for (const [name, value] of Object.entries(fail.headers ?? {})) {
        failed.headers.set(name, value);
      }

      return failed;
    }

    if (method === "GET" && path === "/") {
      return respond({ default_branch: "main" });
    }

    if (method === "GET" && path.startsWith("/git/ref/")) {
      const sha = refs.get(`refs/${path.slice("/git/ref/".length)}`);

      return sha
        ? respond({ object: { sha } })
        : respond({ message: "Not Found" }, 404);
    }

    if (method === "GET" && path.startsWith("/compare/")) {
      const [from = "", to = ""] = path.slice("/compare/".length).split("...");

      if (!commits.has(from) || !commits.has(to)) {
        return respond({ message: "Not Found" }, 404);
      }

      const treeOf = (sha: string) => {
        return (
          trees.get(commits.get(sha)?.tree ?? "") ?? new Map<string, Entry>()
        );
      };
      const left = treeOf(from);
      const right = treeOf(to);
      const files = [...new Set([...left.keys(), ...right.keys()])]
        .filter((name) => {
          return (
            left.get(name)?.sha !== right.get(name)?.sha ||
            left.get(name)?.mode !== right.get(name)?.mode
          );
        })
        .map((filename) => ({ filename }));

      return respond({
        files,
        status:
          from === to
            ? "identical"
            : ancestors(to).has(from)
              ? "ahead"
              : ancestors(from).has(to)
                ? "behind"
                : "diverged",
      });
    }

    if (method === "GET" && path.startsWith("/git/commits/")) {
      const found = commits.get(path.slice("/git/commits/".length));

      return found
        ? respond({ tree: { sha: found.tree } })
        : respond({ message: "Not Found" }, 404);
    }

    if (method === "GET" && path.startsWith("/contents/")) {
      const file = decodeURIComponent(path.slice("/contents/".length));
      const tree = trees.get(
        commits.get(url.searchParams.get("ref") ?? "")?.tree ?? "",
      );
      const entry = tree?.get(file);

      if (entry) {
        const bytes = blobs.get(entry.sha) as Uint8Array;

        // Like GitHub: JSON that names the blob, with the content inline
        // unless the file is big.
        return respond({
          type: entry.mode === "120000" ? "symlink" : "file",
          sha: entry.sha,
          size: reported.get(file) ?? bytes.length,
          encoding: "base64",
          content:
            bytes.length > inlineLimit
              ? ""
              : Buffer.from(bytes).toString("base64"),
        });
      }

      const listing = [...(tree?.keys() ?? [])].filter((name) => {
        return name.startsWith(`${file}/`);
      });

      return listing.length > 0
        ? respond(listing.map((name) => ({ type: "file", path: name })))
        : respond({ message: "Not Found" }, 404);
    }

    if (method === "GET" && path.startsWith("/git/blobs/")) {
      const bytes = blobs.get(path.slice("/git/blobs/".length));

      return bytes
        ? respond({
            encoding: "base64",
            content: Buffer.from(bytes).toString("base64"),
          })
        : respond({ message: "Not Found" }, 404);
    }

    if (method === "POST" && path === "/git/blobs") {
      const bytes = new Uint8Array(Buffer.from(body.content, "base64"));
      const sha = blobSha(bytes);

      blobs.set(sha, bytes);

      return respond({ sha }, 201);
    }

    if (method === "POST" && path === "/git/trees") {
      const tree = new Map(trees.get(body.base_tree));

      for (const entry of body.tree) {
        if (entry.sha === null) {
          tree.delete(entry.path);
        } else {
          tree.set(entry.path, { mode: entry.mode, sha: entry.sha });
        }
      }

      const sha = treeSha(tree);

      trees.set(sha, tree);

      return respond({ sha }, 201);
    }

    if (method === "POST" && path === "/git/commits") {
      const person = (
        kind: string,
        who: { name: string; email: string; date: string },
      ) => {
        return `${kind} ${who.name} <${who.email}> ${gitDate(who.date)}\n`;
      };
      const sha = hash(
        "commit",
        Buffer.from(
          `tree ${body.tree}\n${body.parents.map((parent: string) => `parent ${parent}\n`).join("")}${person("author", body.author)}${person("committer", body.committer)}\n${body.message}`,
        ),
      );

      commits.set(sha, {
        tree: body.tree,
        parents: body.parents,
        message: body.message,
        author: body.author,
      });

      return respond({ sha }, 201);
    }

    if (method === "POST" && path === "/git/refs") {
      refs.set(body.ref, body.sha);

      return respond({ ref: body.ref }, 201);
    }

    if (method === "PATCH" && path.startsWith("/git/refs/")) {
      const ref = `refs/${path.slice("/git/refs/".length)}`;
      const current = refs.get(ref) as string;

      if (!ancestors(body.sha).has(current)) {
        return respond({ message: "Update is not a fast forward" }, 422);
      }

      refs.set(ref, body.sha);

      return respond({ ref });
    }

    return respond({ message: `unhandled ${method} ${path}` }, 500);
  };

  /**
   * Seeds the remote with a commit of a real repository, so the sandbox's
   * clone and the fake agree on the base.
   */
  const seed = (repo: string, commit: string, ref: string) => {
    seedCommit(repo, commit);
    refs.set(ref, commit);
  };

  /**
   * Loads a commit and its ancestors from a real repository.
   */
  const seedCommit = (repo: string, commit: string) => {
    if (commits.has(commit)) {
      return;
    }

    const parents = git(repo, "log", "-1", "--format=%P", commit)
      .split(" ")
      .filter(Boolean);
    const tree = new Map<string, Entry>();

    for (const parent of parents) {
      seedCommit(repo, parent);
    }

    for (const line of git(repo, "ls-tree", "-r", commit).split("\n")) {
      const [meta = "", path = ""] = line.split("\t");
      const [mode = "", , sha = ""] = meta.split(" ");
      const bytes = execFileSync("git", ["cat-file", "blob", sha], {
        cwd: repo,
        env,
        maxBuffer: 64 * 1024 * 1024,
      });

      blobs.set(sha, new Uint8Array(bytes));
      tree.set(path, { mode, sha });
    }

    const treeId = git(repo, "rev-parse", `${commit}^{tree}`);

    trees.set(treeId, tree);
    commits.set(commit, {
      tree: treeId,
      parents,
      message: "base",
      author: {},
    });
  };

  return {
    handle,
    blobs,
    trees,
    commits,
    refs,
    requests,
    fail,
    seed,
    reported,
  };
};
