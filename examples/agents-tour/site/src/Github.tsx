/**
 * @module
 * The GitHub panel: the issues and pull requests of the fake GitHub, each
 * with its comments, and two buttons that open a new one as a person would.
 */
import { useRef, useState } from "react";
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

const stateOf = (item: Item) => {
  if (item.merged) {
    return "merged";
  }

  return item.state;
};

export const Github = () => {
  const state = useFake<State>("/api/github/state", "github");
  const [repo, setRepo] = useState("acme/web");
  const [open, setOpen] = useState<number>();
  const latest = useRef(repo);

  latest.current = repo;

  const create = async (kind: "issues" | "pulls") => {
    const result = await postJson(`/api/github/${latest.current}/${kind}`);

    setOpen(Number(result.number));
  };

  useAction("githubPull", () => {
    void create("pulls");
  });
  useAction("githubIssue", () => {
    void create("issues");
  });

  if (!state) {
    return <p className="empty">Loading...</p>;
  }

  const items = state.items.filter((item) => {
    return item.repo === repo;
  });
  const current = items.find((item) => {
    return item.number === open;
  });
  const comments = state.comments.filter((comment) => {
    return comment.repo === repo && comment.number === open;
  });

  return (
    <div className="github">
      <header className="gh-head">
        <label>
          Repository
          <select
            value={repo}
            onChange={(event) => {
              setRepo(event.target.value);
              setOpen(undefined);
            }}
          >
            {state.repos.map((name) => {
              return <option key={name}>{name}</option>;
            })}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            void create("issues");
          }}
        >
          Open an issue <Kbd action="githubIssue" />
        </button>
        <button
          type="button"
          onClick={() => {
            void create("pulls");
          }}
        >
          Open a pull request <Kbd action="githubPull" />
        </button>
      </header>
      <div className="gh-body">
        <ul className="gh-list" aria-label="Issues and pull requests">
          {items.map((item) => {
            return (
              <li key={item.number}>
                <button
                  type="button"
                  className={item.number === open ? "gh-item on" : "gh-item"}
                  onClick={() => {
                    setOpen(item.number);
                  }}
                >
                  <span className={`gh-state ${stateOf(item)}`}>
                    {item.kind === "issue" ? "Issue" : "PR"} {stateOf(item)}
                  </span>
                  <span className="gh-title">
                    #{item.number} {item.title}
                  </span>
                </button>
              </li>
            );
          })}
          {items.length === 0 ? (
            <li className="empty">Nothing in {repo} yet.</li>
          ) : null}
        </ul>
        <div className="gh-detail" aria-live="polite">
          {current ? (
            <>
              <h3>
                #{current.number} {current.title}
              </h3>
              <p className="gh-meta">
                {current.author}
                {current.branch ? ` wants to merge ${current.branch}` : ""}
                {current.labels.length > 0
                  ? ` ${current.labels.join(", ")}`
                  : ""}
              </p>
              {comments.length === 0 ? (
                <p className="empty">No comments.</p>
              ) : null}
              {comments.map((comment) => {
                return (
                  <div key={comment.id} className="gh-comment">
                    <strong>{comment.author}</strong>
                    <span>{comment.body}</span>
                  </div>
                );
              })}
            </>
          ) : (
            <p className="empty">Pick an item, or open a new one.</p>
          )}
        </div>
      </div>
    </div>
  );
};
