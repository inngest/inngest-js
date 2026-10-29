/**
 * @module
 * EXPERIMENTAL: a small GitHub-like trigger helper and channel adapter. First
 * party GitHub integration is parked; this is the hand-written version it will
 * replace behind the same interface. The event is `github/issue_comment` with
 * the fields below, which your route sends from GitHub's webhook. Anything
 * that can send that event can steer the agent, so the route must verify
 * GitHub's signature before it sends one.
 *
 * Text the agent writes is made inert: an `@mention` is broken so nobody is
 * notified, and an HTML comment cannot forge the ask marker the answer route
 * reads.
 */
import {
  apiError,
  assertAllowed,
  assertSignal,
  type Channel,
  type ChannelAsk,
  type ChannelMessage,
  type ChannelTrigger,
  defineChannel,
  objectSchema,
  parseWith,
  postJson,
  resolveToken,
  retryableStatus,
  truncate,
} from "./channels.ts";

/**
 * The `data` of a `github/issue_comment` event.
 */
export interface GithubCommentData {
  /**
   * The repository's owner.
   */
  owner: string;

  /**
   * The repository's name.
   */
  repo: string;

  /**
   * The issue or pull request number, as GitHub sends it: a whole number.
   */
  number: number;

  /**
   * The comment's text.
   */
  body: string;

  /**
   * The commenter's login. Set it so `ignoreAuthors` can work.
   */
  author?: string;
}

/**
 * The event a GitHub comment is sent as.
 */
export const githubCommentEvent = "github/issue_comment";

const name = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

// A login is a name, or an app's `name[bot]`.
const login = /^[A-Za-z0-9_.-]+(\[bot\])?$/;

const repository =
  /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

const githubCommentSchema = objectSchema<GithubCommentData>({
  owner: { pattern: name },
  repo: { pattern: name },
  number: { integer: { min: 1, max: 9_999_999_999 } },
  body: "string",
  author: "string?",
});

/**
 * Where and as whom a GitHub channel comments.
 */
export interface GithubChannelOptions {
  /**
   * The repositories the agent may comment in, as `"owner/repo"`. The same
   * list as the trigger's `repos`: an event for any other repository is an
   * error.
   */
  repos: string[];

  /**
   * Token, or a function that makes one (it may be async), called each time a
   * comment is posted, so a short-lived installation token such as
   * `() => app.token("acme/app")` is always fresh and a Worker can read it from
   * its per-request bindings. Default: `GITHUB_TOKEN`, read when a comment is
   * posted.
   */
  token?: string | (() => string | Promise<string>);

  /**
   * REST API base URL. Default: `https://api.github.com`. It receives the
   * token, so it must come from your config, never from an event.
   */
  apiUrl?: string;
}

/**
 * The issue or pull request a GitHub channel comments on.
 */
export interface GithubTarget {
  /**
   * The repository's owner.
   */
  owner: string;

  /**
   * The repository's name.
   */
  repo: string;

  /**
   * The issue or pull request number.
   */
  number: number;
}

/**
 * The options of `github.thread`.
 */
export interface GithubThreadOptions {
  /**
   * The repositories to listen to, as `"owner/repo"`. Required: listening
   * everywhere would let any event steer the agent into any repository its
   * token can reach.
   */
  repos: string[];

  /**
   * Logins whose comments start nothing, such as the account the agent posts
   * as: its own comments come back as events and would answer themselves. The
   * route puts the commenter's login in `author`. Names are matched exactly as
   * written, like `repos`.
   */
  ignoreAuthors?: string[];
}

const maxBody = 65_000;

/**
 * Makes model text inert in a comment: `&` is escaped, so an entity such as
 * `&#64;` cannot spell a mention, `@name` becomes `@` and a zero-width space
 * then `name`, so nobody is mentioned, and `<!--` is broken so the text cannot
 * open an HTML comment (the ask marker is one). Code spans get the same
 * treatment: a safe comment matters more than exact code, so `a && b` shows
 * as `a &amp;&amp; b` and an `@` in code carries an invisible character.
 */
const inert = (text: string): string => {
  return text
    .replace(/&/g, "&amp;")
    .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b")
    .replace(/<!--/g, "<\u200b!--");
};

const render = (message: ChannelMessage): string => {
  const text = inert(message.text);

  return message.kind === "error" ? `**Error:** ${text}` : text;
};

const comment = async (
  options: GithubChannelOptions,
  target: GithubTarget,
  body: string,
): Promise<void> => {
  const token = await resolveToken(options.token, "GITHUB_TOKEN", "GitHub");

  const res = await postJson(
    `${options.apiUrl ?? "https://api.github.com"}/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
    {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    { body: truncate(body, maxBody) },
  );

  if (!res.ok) {
    throw apiError(
      `GitHub comment failed: HTTP ${res.status}`,
      retryableStatus(res.status) || (res.status === 403 && res.limited),
    );
  }
};

const askBody = (ask: ChannelAsk): string => {
  assertSignal(ask.signal);

  const lines = [
    inert(ask.question),
    ...(ask.options ?? []).map((option) => {
      return `- ${inert(option)}${option === ask.recommended ? " (recommended)" : ""}`;
    }),
  ];

  // Last, and after the text was made inert, so it is the only marker.
  return `${truncate(lines.join("\n"), maxBody - 300)}\n<!-- inngest-ask:${ask.signal} -->`;
};

/**
 * EXPERIMENTAL: the GitHub trigger helper and channel adapter.
 */
export const github = {
  /**
   * A trigger for comments on an issue or pull request. The comments on one
   * issue are one agent thread.
   */
  thread: (options: GithubThreadOptions): ChannelTrigger<GithubCommentData> => {
    if (!options?.repos?.length) {
      throw new Error(
        "github.thread: `repos` lists the repositories to listen to and cannot be empty.",
      );
    }

    const repos = options.repos.map((full) => {
      if (!repository.test(full)) {
        throw new Error(`github.thread: "${full}" is not an "owner/repo".`);
      }

      const [owner, repo] = full.split("/");

      return `(event.data.owner == ${JSON.stringify(owner)} && event.data.repo == ${JSON.stringify(repo)})`;
    });

    const ignored = (options.ignoreAuthors ?? []).map((who) => {
      if (!login.test(who)) {
        throw new Error(`github.thread: "${who}" is not a login.`);
      }

      return ` && (!has(event.data.author) || event.data.author != ${JSON.stringify(who)})`;
    });

    return {
      event: githubCommentEvent,
      if: `(${repos.join(" || ")})${ignored.join("")}`,
      thread:
        '"github:" + event.data.owner + "/" + event.data.repo + "#" + string(int(event.data.number))',
      message: (event) => {
        return (event.data as unknown as GithubCommentData).body;
      },
      schema: githubCommentSchema,
    };
  },

  /**
   * The channel that comments on an issue or pull request. It throws when the
   * event's repository is not in `options.repos`.
   */
  channel: (
    /**
     * A `github/issue_comment` event, or the target itself.
     */
    source: { data: unknown } | GithubTarget,
    options: GithubChannelOptions,
  ): Channel => {
    if (!options?.repos?.length) {
      throw new Error(
        "github.channel: `repos` lists the repositories it may comment in and cannot be empty.",
      );
    }

    const target: GithubTarget = (() => {
      const data = parseWith(
        githubCommentSchema,
        "number" in source ? { ...source, body: "" } : source.data,
        "github.channel: the event or target is not valid",
      );

      return {
        owner: data.owner,
        repo: data.repo,
        number: data.number,
      };
    })();

    assertAllowed(
      "repository",
      `${target.owner}/${target.repo}`,
      options.repos,
    );

    return defineChannel({
      post: async (message) => {
        // GitHub rejects an empty comment, and a message of blocks alone (a
        // `report.finish({ blocks })`) has nothing here to show.
        if (message.text === "") {
          return;
        }

        await comment(options, target, render(message));
      },
      ask: async (ask) => {
        await comment(options, target, askBody(ask));
      },
    });
  },
};
