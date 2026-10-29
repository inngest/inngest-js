/**
 * @module
 * The GitHub panel: the issues and pull requests of the fake GitHub, each
 * with its comments, and two buttons that open a new one as a person would.
 */
import { Kbd } from "./keyboard.tsx";
import { postJson, useAction, useFake } from "./live.ts";

interface Item {
  repo: string;
  number: number;
  kind: "issue" | "pull_request";
  title: string;
  state: string;
  merged: boolean;
  labels: string[];
  author: string;
  branch: string | null;
  updatedAt: string;
}

interface Comment {
  id: number;
  repo: string;
  number: number;
  author: string;
  body: string;
}

interface State {
  repos: string[];
  items: Item[];
  comments: Comment[];
}

const repo = "acme/web";

export const Github = () => {
  const state = useFake<State>("/api/github/state", "github");

  const act = (path: string) => {
    return postJson(`/api/github/${repo}/${path}`);
  };

  useAction("githubPull", () => {
    void act("pulls");
  });
  useAction("githubIssue", () => {
    void act("issues");
  });
  useAction("githubComment", () => {
    void act("comment");
  });
  useAction("githubApprove", () => {
    void act("approve");
  });

  if (!state) {
    return <p className="empty">Loading...</p>;
  }

  const items = [
    ...state.items.filter((item) => {
      return item.repo === repo;
    }),
  ].reverse();

  return (
    <div className="github">
      <header className="gh-head">
        <span className="topic">{repo}</span>
        {(
          [
            ["issues", "Create issue", "githubIssue"],
            ["pulls", "Open PR", "githubPull"],
            ["comment", "Comment", "githubComment"],
            ["approve", "Approve", "githubApprove"],
          ] as const
        ).map(([path, name, action]) => {
          return (
            <button
              type="button"
              key={path}
              onClick={() => {
                void act(path);
              }}
            >
              {name} <Kbd action={action} />
            </button>
          );
        })}
      </header>
      <div className="gh-feed">
        {items.length === 0 ? <p className="empty">Nothing yet.</p> : null}
        {items.map((item) => {
          return (
            <div key={item.number} className="gh-entry">
              <div className="gh-title">
                <span className="gh-state">
                  {item.kind === "issue" ? "Issue" : "PR"}{" "}
                  {item.merged ? "merged" : item.state}
                </span>
                #{item.number} {item.title}
              </div>
              {state.comments
                .filter((comment) => {
                  return (
                    comment.repo === repo && comment.number === item.number
                  );
                })
                .map((comment) => {
                  return (
                    <div key={comment.id} className="gh-comment">
                      <strong>{comment.author}</strong>
                      <span>{comment.body}</span>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
};
