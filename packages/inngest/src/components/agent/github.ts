/**
 * @module
 * EXPERIMENTAL: a small GitHub-like trigger helper and channel adapter. First
 * party GitHub integration is parked; this is the hand-written version it will
 * replace behind the same interface. The event is `github/issue_comment` with
 * the fields below, which your route sends from GitHub's webhook.
 */
import {
  type Channel,
  type ChannelTrigger,
  defineChannel,
  objectSchema,
  parseWith,
} from "./channels.ts";

/**
 * The `data` of a `github/issue_comment` event.
 */
export interface GithubCommentData {
  owner: string;
  repo: string;

  /**
   * The issue or pull request number, as a string: a thread key is built
   * from strings only.
   */
  number: string;
  body: string;
  author?: string;
}

/**
 * The event a GitHub comment is sent as.
 */
export const githubCommentEvent = "github/issue_comment";

const githubCommentSchema = objectSchema<GithubCommentData>({
  owner: "string",
  repo: "string",
  number: "string",
  body: "string",
  author: "string?",
});

/**
 * Where and as whom a GitHub channel comments.
 */
export interface GithubChannelOptions {
  /**
   * Token. Default: `GITHUB_TOKEN`, read when a comment is posted.
   */
  token?: string;

  /**
   * REST API base URL. Default: `https://api.github.com`.
   */
  apiUrl?: string;
}

/**
 * The issue or pull request a GitHub channel comments on.
 */
export interface GithubTarget {
  owner: string;
  repo: string;
  number: number;
}

const comment = async (
  options: GithubChannelOptions,
  target: GithubTarget,
  body: string,
): Promise<void> => {
  const token =
    options.token ??
    (typeof process === "undefined" ? undefined : process.env.GITHUB_TOKEN);

  const res = await fetch(
    `${options.apiUrl ?? "https://api.github.com"}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.number}/comments`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!res.ok) {
    throw new Error(`GitHub comment failed: HTTP ${res.status}`);
  }
};

/**
 * EXPERIMENTAL: the GitHub trigger helper and channel adapter.
 */
export const github = {
  /**
   * A trigger for comments on an issue or pull request. The comments on one
   * issue are one agent thread.
   * @param options.repos Repositories to listen to as `"owner/repo"`.
   * Default: every repository.
   */
  comment: (
    options: { repos?: string[] } = {},
  ): ChannelTrigger<GithubCommentData> => {
    const repos = options.repos?.map((full) => {
      const [owner, repo] = full.split("/");

      if (!owner || !repo) {
        throw new Error(
          `github.comment: "${full}" is not an "owner/repo" repository.`,
        );
      }

      return `(event.data.owner == ${JSON.stringify(owner)} && event.data.repo == ${JSON.stringify(repo)})`;
    });

    return {
      event: githubCommentEvent,
      ...(repos?.length ? { if: `(${repos.join(" || ")})` } : {}),
      thread:
        '"github:" + event.data.owner + "/" + event.data.repo + "#" + event.data.number',
      message: (event) => {
        return (event.data as unknown as GithubCommentData).body;
      },
      schema: githubCommentSchema,
    };
  },

  /**
   * The channel that comments on an issue or pull request.
   * @param source A `github/issue_comment` event, or the target itself.
   * @param options Token and API URL.
   */
  channel: (
    source: { data: unknown } | GithubTarget,
    options: GithubChannelOptions = {},
  ): Channel => {
    const target: GithubTarget = (() => {
      if ("number" in source && typeof source.number === "number") {
        return source;
      }

      const data = parseWith(
        githubCommentSchema,
        (source as { data: unknown }).data,
        "github.channel: the event is not a github/issue_comment",
      );

      const number = Number(data.number);

      if (!Number.isInteger(number)) {
        throw new Error(
          `github.channel: "${data.number}" is not an issue number.`,
        );
      }

      return { owner: data.owner, repo: data.repo, number };
    })();

    return defineChannel({
      post: async (message) => {
        await comment(options, target, message.text);
      },
      ask: async (ask) => {
        const lines = [
          ask.question,
          ...(ask.options ?? []).map((option) => {
            return `- ${option}${option === ask.recommended ? " (recommended)" : ""}`;
          }),
          `<!-- inngest-ask:${ask.signal} -->`,
        ];

        await comment(options, target, lines.join("\n"));
      },
    });
  },
};
