/**
 * @module
 * The fake GitHub. `/github/repos/...` is the REST subset the agents' tools
 * use (issues, comments, labels, pull requests, files, merge), shaped like
 * api.github.com. The mini UI's routes under `/api/github` open issues and
 * pull requests. Every change, whoever makes it, is stored, shown live and
 * sent as the matching webhook-style event.
 */
import type { Inngest } from "inngest";
import type { Db } from "./db.ts";
import { issueFixtures, prFixtures } from "./fixtures.ts";
import { HttpError, type Router } from "./http.ts";
import { botLogin, githubRepos, humanLogin } from "./settings.ts";

interface ItemRow {
  id: number;
  repo: string;
  number: number;
  kind: "issue" | "pull_request";
  title: string;
  body: string;
  state: "open" | "closed";
  merged: number;
  labels: string;
  author: string;
  branch: string | null;
  base: string | null;
  files: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: number;
  repo: string;
  number: number;
  author: string;
  body: string;
  created_at: string;
}

interface PatchFile {
  filename: string;
  patch: string;
}

const labelColors: Record<string, string> = {
  bug: "d73a4a",
  enhancement: "a2eeef",
  documentation: "0075ca",
  question: "d876e3",
  triaged: "5b5bf0",
};

const now = () => {
  return new Date().toISOString();
};

const countLines = (patch: string, sign: "+" | "-") => {
  return patch.split("\n").filter((line) => {
    return line.startsWith(sign) && !line.startsWith(`${sign}${sign}`);
  }).length;
};

const split = (full: string) => {
  const [owner = "", repo = ""] = full.split("/");

  return { owner, repo };
};

const pick = <T>(list: T[]) => {
  return list[Math.floor(Math.random() * list.length)] as T;
};

export interface GithubDeps {
  db: Db;
  router: Router;
  inngest: Inngest;
  changed: () => void;
}

export const setupGithub = (deps: GithubDeps) => {
  const { db, router, inngest, changed } = deps;

  db.exec(`
    CREATE TABLE IF NOT EXISTS gh_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, number INTEGER NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open', merged INTEGER NOT NULL DEFAULT 0,
      labels TEXT NOT NULL DEFAULT '[]', author TEXT NOT NULL, branch TEXT, base TEXT,
      files TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (repo, number)
    );
    CREATE TABLE IF NOT EXISTS gh_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, number INTEGER NOT NULL,
      author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);

  const item = (repo: string, number: number) => {
    const found = db.get<ItemRow>(
      "SELECT * FROM gh_items WHERE repo = ? AND number = ?",
      repo,
      number,
    );

    if (!found || !githubRepos.includes(repo)) {
      throw new HttpError(404, { message: "Not Found" });
    }

    return found;
  };

  const create = (
    repo: string,
    kind: ItemRow["kind"],
    fields: {
      title: string;
      body: string;
      author: string;
      branch?: string;
      files?: PatchFile[];
      labels?: string[];
    },
  ) => {
    if (!githubRepos.includes(repo)) {
      throw new HttpError(404, { message: "Not Found" });
    }

    const next =
      (db.get<{ n: number | null }>(
        "SELECT MAX(number) AS n FROM gh_items WHERE repo = ?",
        repo,
      )?.n ?? 0) + 1;

    db.run(
      `INSERT INTO gh_items (repo, number, kind, title, body, author, branch, base, files, labels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      repo,
      next,
      kind,
      fields.title,
      fields.body,
      fields.author,
      fields.branch ?? null,
      kind === "pull_request" ? "main" : null,
      fields.files ? JSON.stringify(fields.files) : null,
      JSON.stringify(fields.labels ?? []),
      now(),
      now(),
    );

    return item(repo, next);
  };

  // The webhook-style event for a change. A failed send must not fail the change.
  const emit = async (name: string, data: Record<string, unknown>) => {
    changed();

    try {
      await inngest.send({ name, data });
    } catch (error) {
      console.error("could not send event", String(error));
    }
  };

  const eventData = (row: ItemRow, sender: string) => {
    return {
      ...split(row.repo),
      number: row.number,
      title: row.title,
      body: row.body,
      sender,
    };
  };

  const openIssue = async (
    repo: string,
    fields: { title: string; body: string },
    actor: string,
  ) => {
    const row = create(repo, "issue", { ...fields, author: actor });

    await emit("github/issues.opened", eventData(row, actor));

    return row;
  };

  const openPr = async (
    repo: string,
    fields: {
      title: string;
      body: string;
      branch: string;
      file: string;
      patch: string;
    },
    actor: string,
  ) => {
    const row = create(repo, "pull_request", {
      title: fields.title,
      body: fields.body,
      author: actor,
      branch: fields.branch,
      files: [{ filename: fields.file, patch: fields.patch }],
    });

    await emit("github/pull_request.opened", {
      ...eventData(row, actor),
      branch: fields.branch,
      base: "main",
    });

    return row;
  };

  const comment = async (
    repo: string,
    number: number,
    body: string,
    actor: string,
  ) => {
    const row = item(repo, number);
    const { id } = db.run(
      "INSERT INTO gh_comments (repo, number, author, body, created_at) VALUES (?, ?, ?, ?, ?)",
      repo,
      number,
      actor,
      body,
      now(),
    );

    db.run("UPDATE gh_items SET updated_at = ? WHERE id = ?", now(), row.id);

    await emit("github/issue_comment", {
      ...split(repo),
      number,
      body,
      author: actor,
      kind: row.kind,
      title: row.title,
    });

    return db.get<CommentRow>(
      "SELECT * FROM gh_comments WHERE id = ?",
      id,
    ) as CommentRow;
  };

  const setState = async (
    repo: string,
    number: number,
    state: "open" | "closed",
    actor: string,
    merged = false,
  ) => {
    const row = item(repo, number);

    if (row.state === state) {
      return row;
    }

    if (row.merged === 1 && state === "open") {
      throw new HttpError(422, {
        message: "A merged pull request cannot be reopened",
      });
    }

    db.run(
      "UPDATE gh_items SET state = ?, merged = ?, updated_at = ? WHERE id = ?",
      state,
      merged ? 1 : row.merged,
      now(),
      row.id,
    );

    const next = item(repo, number);
    const pull = row.kind === "pull_request";
    const data = eventData(next, actor);

    if (state === "open") {
      await emit(
        pull ? "github/pull_request.reopened" : "github/issues.reopened",
        data,
      );
    } else if (pull) {
      await emit(
        merged ? "github/pull_request.merged" : "github/pull_request.closed",
        data,
      );
    } else {
      await emit("github/issues.closed", data);
    }

    return next;
  };

  const merge = async (repo: string, number: number, actor: string) => {
    const row = item(repo, number);

    if (row.kind !== "pull_request" || row.state !== "open") {
      throw new HttpError(405, { message: "Pull Request is not mergeable" });
    }

    return setState(repo, number, "closed", actor, true);
  };

  const addLabels = async (
    repo: string,
    number: number,
    names: string[],
    actor: string,
  ) => {
    const row = item(repo, number);
    const have = JSON.parse(row.labels) as string[];
    const added = names.filter((name) => {
      return !have.includes(name);
    });

    db.run(
      "UPDATE gh_items SET labels = ?, updated_at = ? WHERE id = ?",
      JSON.stringify([...have, ...added]),
      now(),
      row.id,
    );

    const next = item(repo, number);

    for (const label of added) {
      await emit(
        row.kind === "pull_request"
          ? "github/pull_request.labeled"
          : "github/issues.labeled",
        { ...eventData(next, actor), label },
      );
    }

    changed();

    return next;
  };

  // --- shapes of api.github.com ------------------------------------------------

  const user = (login: string) => {
    return {
      login,
      id: login.length,
      type: login.endsWith("bot") ? "Bot" : "User",
    };
  };

  const labelsOf = (row: ItemRow) => {
    return (JSON.parse(row.labels) as string[]).map((name, index) => {
      return { id: index + 1, name, color: labelColors[name] ?? "ededed" };
    });
  };

  const base = (row: ItemRow) => {
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      body: row.body,
      state: row.state,
      user: user(row.author),
      labels: labelsOf(row),
      created_at: row.created_at,
      updated_at: row.updated_at,
      html_url: `https://github.com/${row.repo}/${row.kind === "pull_request" ? "pull" : "issues"}/${row.number}`,
    };
  };

  const issueJson = (row: ItemRow) => {
    return {
      ...base(row),
      ...(row.kind === "pull_request"
        ? { pull_request: { url: base(row).html_url } }
        : {}),
    };
  };

  const files = (row: ItemRow) => {
    return (JSON.parse(row.files ?? "[]") as PatchFile[]).map((file) => {
      const additions = countLines(file.patch, "+");
      const deletions = countLines(file.patch, "-");

      return {
        filename: file.filename,
        status: "modified",
        additions,
        deletions,
        changes: additions + deletions,
        patch: file.patch,
      };
    });
  };

  const pullJson = (row: ItemRow) => {
    return {
      ...base(row),
      merged: row.merged === 1,
      head: { ref: row.branch, sha: "a1b2c3d" },
      base: { ref: row.base ?? "main" },
      changed_files: files(row).length,
    };
  };

  const commentJson = (row: CommentRow) => {
    return {
      id: row.id,
      body: row.body,
      user: user(row.author),
      created_at: row.created_at,
    };
  };

  const repoOf = (params: Record<string, string>) => {
    return `${params.owner}/${params.repo}`;
  };

  // --- REST --------------------------------------------------------------------

  const itemsOf = (repo: string, kind: string | undefined, state: string) => {
    return db
      .all<ItemRow>(
        "SELECT * FROM gh_items WHERE repo = ? ORDER BY number DESC",
        repo,
      )
      .filter((row) => {
        return (
          (kind === undefined || row.kind === kind) &&
          (state === "all" || row.state === state)
        );
      });
  };

  router.route(
    "GET",
    "/github/repos/:owner/:repo/issues",
    ({ params, query }) => {
      return itemsOf(
        repoOf(params),
        undefined,
        query.get("state") ?? "open",
      ).map(issueJson);
    },
  );

  router.route(
    "POST",
    "/github/repos/:owner/:repo/issues",
    async ({ params, body }) => {
      return issueJson(
        await openIssue(
          repoOf(params),
          { title: String(body.title), body: String(body.body ?? "") },
          botLogin,
        ),
      );
    },
  );

  router.route(
    "GET",
    "/github/repos/:owner/:repo/issues/:number",
    ({ params }) => {
      return issueJson(item(repoOf(params), Number(params.number)));
    },
  );

  router.route(
    "PATCH",
    "/github/repos/:owner/:repo/issues/:number",
    async ({ params, body }) => {
      const repo = repoOf(params);
      const number = Number(params.number);

      if (body.state === "open" || body.state === "closed") {
        await setState(repo, number, body.state, botLogin);
      }

      return issueJson(item(repo, number));
    },
  );

  router.route(
    "POST",
    "/github/repos/:owner/:repo/issues/:number/comments",
    async ({ params, body }) => {
      return commentJson(
        await comment(
          repoOf(params),
          Number(params.number),
          String(body.body ?? ""),
          botLogin,
        ),
      );
    },
  );

  router.route(
    "POST",
    "/github/repos/:owner/:repo/issues/:number/labels",
    async ({ params, body }) => {
      const names = (Array.isArray(body.labels) ? body.labels : []).map(String);

      return labelsOf(
        await addLabels(repoOf(params), Number(params.number), names, botLogin),
      );
    },
  );

  router.route(
    "GET",
    "/github/repos/:owner/:repo/pulls",
    ({ params, query }) => {
      return itemsOf(
        repoOf(params),
        "pull_request",
        query.get("state") ?? "open",
      ).map(pullJson);
    },
  );

  router.route(
    "GET",
    "/github/repos/:owner/:repo/pulls/:number",
    ({ params }) => {
      const row = item(repoOf(params), Number(params.number));

      if (row.kind !== "pull_request") {
        throw new HttpError(404, { message: "Not Found" });
      }

      return pullJson(row);
    },
  );

  router.route(
    "GET",
    "/github/repos/:owner/:repo/pulls/:number/files",
    ({ params }) => {
      return files(item(repoOf(params), Number(params.number)));
    },
  );

  router.route(
    "PUT",
    "/github/repos/:owner/:repo/pulls/:number/merge",
    async ({ params }) => {
      await merge(repoOf(params), Number(params.number), botLogin);

      return {
        merged: true,
        sha: "d4e5f6a",
        message: "Pull Request successfully merged",
      };
    },
  );

  // --- the mini UI --------------------------------------------------------------

  router.route("GET", "/api/github/state", () => {
    return {
      repos: githubRepos,
      items: db
        .all<ItemRow>("SELECT * FROM gh_items ORDER BY number DESC")
        .map((row) => {
          return {
            repo: row.repo,
            number: row.number,
            kind: row.kind,
            title: row.title,
            state: row.state,
            merged: row.merged === 1,
            labels: JSON.parse(row.labels) as string[],
            author: row.author,
            branch: row.branch,
            updatedAt: row.updated_at,
          };
        }),
      comments: db
        .all<CommentRow>("SELECT * FROM gh_comments ORDER BY id")
        .map((row) => {
          return {
            id: row.id,
            repo: row.repo,
            number: row.number,
            author: row.author,
            body: row.body,
          };
        }),
    };
  });

  /**
   * Opens a random issue or pull request as the person.
   */
  const openRandom = async (repo: string, kind: "issue" | "pull_request") => {
    if (kind === "issue") {
      const fixture = pick(issueFixtures);

      return openIssue(repo, fixture, humanLogin);
    }

    return openPr(repo, pick(prFixtures), humanLogin);
  };

  router.route(
    "POST",
    "/api/github/:owner/:repo/issues",
    async ({ params }) => {
      const row = await openRandom(repoOf(params), "issue");

      return { number: row.number };
    },
  );

  const comments = [
    "Can you take a look at this?",
    "I can reproduce this on the latest release.",
    "Any update here? A customer is waiting on it.",
    "This looks related to the change from last week.",
  ];

  const latest = (repo: string, kind?: "pull_request") => {
    return db.get<ItemRow>(
      `SELECT * FROM gh_items WHERE repo = ? ${kind ? "AND kind = 'pull_request'" : ""} ORDER BY number DESC LIMIT 1`,
      repo,
    );
  };

  router.route(
    "POST",
    "/api/github/:owner/:repo/comment",
    async ({ params }) => {
      const repo = repoOf(params);
      const row = latest(repo);

      if (!row) {
        return { error: "Nothing to comment on yet" };
      }

      await comment(repo, row.number, pick(comments), humanLogin);

      return { number: row.number };
    },
  );

  router.route(
    "POST",
    "/api/github/:owner/:repo/approve",
    async ({ params }) => {
      const repo = repoOf(params);
      const row = latest(repo, "pull_request");

      if (!row) {
        return { error: "Open a pull request first" };
      }

      await comment(repo, row.number, "Approved. Ship it.", humanLogin);

      return { number: row.number };
    },
  );

  router.route("POST", "/api/github/:owner/:repo/pulls", async ({ params }) => {
    const row = await openRandom(repoOf(params), "pull_request");

    return { number: row.number };
  });

  // --- first run ---------------------------------------------------------------

  // A few items so the first run has something to list.
  const seed = () => {
    const issue = (
      repo: string,
      index: number,
      author: string,
      labels: string[],
    ) => {
      const fixture = issueFixtures[index];

      create(repo, "issue", {
        title: fixture?.title ?? "",
        body: fixture?.body ?? "",
        author,
        labels,
      });
    };
    const pr = (repo: string, index: number, author: string) => {
      const fixture = prFixtures[index];

      create(repo, "pull_request", {
        title: fixture?.title ?? "",
        body: fixture?.body ?? "",
        author,
        branch: fixture?.branch,
        files: [{ filename: fixture?.file ?? "", patch: fixture?.patch ?? "" }],
      });
    };

    issue("acme/web", 0, "dana", ["bug"]);
    issue("acme/web", 1, "lee", ["bug"]);
    issue("acme/web", 4, "sam", []);
    pr("acme/web", 0, "priya");
    pr("acme/web", 1, "dana");
    issue("acme/api", 3, "sam", ["bug"]);
    pr("acme/api", 2, "dana");
    pr("acme/api", 3, "lee");
    issue("acme/docs", 5, "lee", ["documentation"]);
    pr("acme/docs", 4, "priya");
  };

  seed();

  return {
    reset: () => {
      for (const table of ["gh_items", "gh_comments", "sqlite_sequence"]) {
        db.run(`DELETE FROM ${table}`);
      }

      seed();
      changed();
    },
  };
};
