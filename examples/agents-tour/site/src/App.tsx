/**
 * @module
 * The tour: lesson text on the left; the editor, the run controls and the
 * panels on the right; a bar to move between pages.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionId } from "../../shared/keys.ts";
import type {
  Page,
  PageSummary,
  TourEvent,
  TourIndex,
  TraceRun,
} from "../../shared/types.ts";
import { api } from "./api.ts";
import { addTypes, Editor, type EditorApi, type Marker } from "./Editor.tsx";
import { Events } from "./Events.tsx";
import { Github } from "./Github.tsx";
import { type Handlers, Kbd, shortcutsOf, useKeyboard } from "./keyboard.tsx";
import { announceChange, sendAction } from "./live.ts";
import { renderMarkdown } from "./markdown.ts";
import { Cheat, Contents, Search } from "./overlays.tsx";
import { MessagePanel } from "./panels.tsx";
import { Divider } from "./panes.tsx";
import { hash, store } from "./platform.ts";
import { Slack } from "./Slack.tsx";
import { TracePanel } from "./trace.tsx";

type PlayTab = "message" | "slack" | "github" | "events";
type Overlay = "contents" | "search" | "cheat" | null;
type Theme = "system" | "light" | "dark";
type Line = Extract<TourEvent, { type: "log" }>;
type Status = Extract<TourEvent, { type: "status" }>;

const tabNames: Record<PlayTab, string> = {
  message: "Messages",
  slack: "Slack",
  github: "GitHub",
  events: "Events",
};

const pathOf = (id: string) => {
  return `/tour/${id}`;
};

const idFromPath = () => {
  const match = /^\/tour\/(.+)$/.exec(window.location.pathname);

  return match?.[1];
};

const editKey = (page: Page) => {
  const original = page.files.find((file) => {
    return file.editable;
  });

  return `tour:edit:${page.id}:${hash(original?.content ?? "")}`;
};

const prefersDark = () => {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

export const App = () => {
  const [index, setIndex] = useState<TourIndex>();
  const [page, setPage] = useState<Page>();
  const [files, setFiles] = useState<Page["files"]>([]);
  const [active, setActive] = useState("agent.ts");
  const [ready, setReady] = useState(false);
  const [devServerUrl, setDevServerUrl] = useState("");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [runs, setRuns] = useState<TraceRun[]>([]);
  const [status, setStatus] = useState<Status>({
    type: "status",
    state: "idle",
    text: "Connecting...",
  });
  const [everything, setEverything] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    (store.get("tour:theme") as Theme | null) ?? "system",
  );
  const [systemDark, setSystemDark] = useState(prefersDark());
  const [cols, setCols] = useState(Number(store.get("tour:cols")) || 42);
  const [leftRow, setLeftRow] = useState(Number(store.get("tour:left")) || 58);
  const [rightRow, setRightRow] = useState(
    Number(store.get("tour:right")) || 56,
  );
  const [play, setPlay] = useState<PlayTab>("message");
  const [undo, setUndo] = useState<Record<string, string> | null>(null);
  const editor = useRef<EditorApi>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const textPane = useRef<HTMLElement>(null);
  const undoTimer = useRef<number | undefined>(undefined);
  const dark = theme === "system" ? systemDark : theme === "dark";

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => {
      setSystemDark(query.matches);
    };

    query.addEventListener("change", change);

    return () => {
      query.removeEventListener("change", change);
    };
  }, []);

  useEffect(() => {
    void api.index().then(setIndex);
    void api.info().then((info) => {
      setDevServerUrl(info.devServerUrl);
    });
    // The SDK's declarations go in before any page opens, so the editor's
    // first check of a page already knows them.
    void api.types().then((files) => {
      addTypes(files);
      setReady(true);
    });

    return api.stream((event) => {
      if (event.type === "log") {
        setLines((previous) => {
          return [...previous, event];
        });
      } else if (event.type === "clear") {
        setLines([]);
      } else if (event.type === "status") {
        setStatus(event);
      } else if (event.type === "runs") {
        setRuns(event.runs);
      } else if (event.type === "fakes") {
        announceChange(event.topic);
      }
    });
  }, []);

  const flat = useMemo(() => {
    return (
      index?.lessons.flatMap((lesson) => {
        return lesson.pages;
      }) ?? []
    );
  }, [index]);

  const open = useCallback((id: string, push = true) => {
    void api.page(id).then((next) => {
      const saved = store.get(editKey(next));
      const loaded = next.files.map((file) => {
        return file.editable && saved !== null
          ? { ...file, content: saved }
          : file;
      });

      void api.open(next.id);
      setPage(next);
      setFiles(loaded);
      setActive("agent.ts");
      setLines([]);
      setUndo(null);
      store.set("tour:last", id);

      if (push) {
        window.history.pushState(null, "", pathOf(id));
      }

      window.setTimeout(() => {
        if (next.manifest.code === false) {
          textPane.current?.focus();
        } else {
          editor.current?.focus();
        }
      }, 50);
    });
  }, []);

  useEffect(() => {
    if (flat.length === 0 || !ready) {
      return;
    }

    const wanted = idFromPath() ?? store.get("tour:last") ?? flat[0]?.id;
    const known = flat.find((candidate) => {
      return candidate.id === wanted;
    });

    open(known?.id ?? (flat[0]?.id as string), idFromPath() === undefined);

    const onPop = () => {
      const id = idFromPath();

      if (id) {
        open(id, false);
      }
    };

    window.addEventListener("popstate", onPop);

    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, [flat, open, ready]);

  const position = flat.findIndex((candidate) => {
    return candidate.id === page?.id;
  });

  const go = (offset: number) => {
    const target = flat[position + offset];

    if (target) {
      open(target.id);
    } else if (offset > 0) {
      setOverlay("contents");
    }
  };

  const hasCode = page?.manifest.code !== false;
  const live = runs.some((run) => {
    return !["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(
      run.status,
    );
  });

  const run = async () => {
    if (!page || !hasCode) {
      return;
    }

    await editor.current?.format();

    const values = editor.current?.values() ?? {};
    const edited = values["agent.ts"];

    if (edited !== undefined) {
      store.set(editKey(page), edited);
    }

    void api.run(page.id, values);
    editor.current?.focus();
  };

  const reset = () => {
    if (!page || !hasCode) {
      return;
    }

    const before = editor.current?.values() ?? {};

    for (const file of page.files) {
      editor.current?.setValue(file.name, file.content);
    }

    store.remove(editKey(page));
    setUndo(before);
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => {
      setUndo(null);
    }, 10_000);
    void api.reset();
    editor.current?.focus();
  };

  const undoReset = () => {
    if (!undo || !page) {
      return;
    }

    for (const [name, content] of Object.entries(undo)) {
      editor.current?.setValue(name, content);
    }

    setUndo(null);
    editor.current?.focus();
  };

  const toggleEditor = () => {
    if (editor.current?.hasFocus()) {
      runButton.current?.focus();
    } else {
      editor.current?.focus();
    }
  };

  const cycleTheme = () => {
    const next: Theme =
      theme === "system" ? "light" : theme === "light" ? "dark" : "system";

    setTheme(next);
    store.set("tour:theme", next);
  };

  const showRun = () => {
    if (
      files.some((file) => {
        return file.name === "run.ts";
      })
    ) {
      setActive("run.ts");
    }
  };

  const nextFile = () => {
    const at = files.findIndex((file) => {
      return file.name === active;
    });
    const next = files[(at + 1) % Math.max(1, files.length)];

    if (next) {
      setActive(next.name);
    }
  };

  const target = page?.manifest.message;
  const panels: PlayTab[] =
    (page?.manifest.panels as PlayTab[] | undefined) ??
    (target ? ["message"] : []);
  const panelsKey = panels.join(",");

  useEffect(() => {
    setPlay(panelsKey.split(",")[0] as PlayTab);
  }, [page?.id, panelsKey]);

  // Opens a tab of the play pane, then focuses something in it or hands a key
  // action to it once it is on screen.
  const playTo = (tab: PlayTab, then: string | ActionId) => {
    if (!panels.includes(tab)) {
      return;
    }

    setPlay(tab);
    window.setTimeout(() => {
      if (then.startsWith(".")) {
        document.querySelector<HTMLElement>(then)?.focus();
      } else {
        sendAction(then as ActionId);
      }
    }, 40);
  };

  const focusIn = (selector: string) => {
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(selector)?.focus();
    }, 0);
  };

  const handlers: Handlers = {
    run,
    kill: () => {
      void api.kill();
    },
    reset,
    format: () => {
      void editor.current?.format();
    },
    next: () => {
      go(1);
    },
    prev: () => {
      go(-1);
    },
    cheat: () => {
      setOverlay("cheat");
    },
    contents: () => {
      setOverlay("contents");
    },
    search: () => {
      setOverlay("search");
    },
    text: () => {
      textPane.current?.focus();
    },
    trace: () => {
      focusIn(".trace [data-row], .trace");
    },
    message: () => {
      playTo("message", ".message button");
    },
    slack: () => {
      playTo("slack", ".slack-head button");
    },
    github: () => {
      playTo("github", ".gh-head button");
    },
    events: () => {
      playTo("events", ".events button");
    },
    slackCompose: () => {
      playTo("slack", "slackCompose");
    },
    slackNew: () => {
      playTo("slack", "slackNew");
    },
    approve: () => {
      playTo("slack", "approve");
    },
    deny: () => {
      playTo("slack", "deny");
    },
    sendOther: () => {
      playTo("message", "sendOther");
    },
    githubComment: () => {
      playTo("github", "githubComment");
    },
    githubApprove: () => {
      playTo("github", "githubApprove");
    },
    githubPull: () => {
      playTo("github", "githubPull");
    },
    githubIssue: () => {
      playTo("github", "githubIssue");
    },
    sendEvent: () => {
      playTo(play === "message" ? "message" : "events", "sendEvent");
    },
    file: nextFile,
    devserver: () => {
      if (devServerUrl) {
        window.open(devServerUrl, "_blank", "noopener");
      }
    },
    runEvent: () => {
      showRun();
    },
    rowDown: () => {},
    rowUp: () => {},
    rowOpen: () => {},
    everything: () => {
      setEverything((value) => {
        return !value;
      });
    },
    editor: toggleEditor,
    undo: undoReset,
    theme: cycleTheme,
  };
  const latest = useRef(handlers);

  latest.current = handlers;
  useKeyboard(handlers, () => {
    return overlay !== null;
  });

  const markers: Marker[] = useMemo(() => {
    const out: Marker[] = [];

    for (const line of lines) {
      const match = /agent\.ts:(\d+)/.exec(line.text);

      if (line.kind === "err" && match) {
        out.push({
          file: "agent.ts",
          line: Number(match[1]),
          message: line.text,
        });
      }
    }

    return out;
  }, [lines]);

  const pick = (summary: PageSummary) => {
    setOverlay(null);
    open(summary.id);
  };

  const saveSplit = (
    key: string,
    set: (value: number) => void,
    value: number,
  ) => {
    set(value);
    store.set(key, String(Math.round(value)));
  };

  const tabKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ),
    ];
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;

    if (event.key === "ArrowRight") {
      next = (at + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      next = (at - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tabs.length - 1;
    }

    if (next !== undefined) {
      event.preventDefault();
      tabs[next]?.focus();
      tabs[next]?.click();
    }
  };

  if (!index || !page) {
    return <div className="loading">Loading the tour...</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo" aria-hidden="true" />
        <h1>Agents Tour</h1>
        <nav>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setOverlay("contents");
            }}
            aria-keyshortcuts={shortcutsOf("contents")}
          >
            Contents <Kbd action="contents" />
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setOverlay("search");
            }}
            aria-keyshortcuts={shortcutsOf("search")}
          >
            Search <Kbd action="search" />
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setOverlay("cheat");
            }}
            aria-keyshortcuts={shortcutsOf("cheat")}
          >
            Keys <Kbd action="cheat" />
          </button>
          <button
            type="button"
            className="ghost"
            onClick={handlers.devserver}
            title="The Dev Server in this tour is a bare binary with no dashboard, so this opens a stub page. The Trace pane shows the same runs."
            aria-keyshortcuts={shortcutsOf("devserver")}
          >
            Dev Server <Kbd action="devserver" />
          </button>
          <button
            type="button"
            className="ghost"
            onClick={cycleTheme}
            aria-keyshortcuts={shortcutsOf("theme")}
          >
            Theme: {theme} <Kbd action="theme" />
          </button>
        </nav>
      </header>

      <main
        className={hasCode ? "grid" : "single"}
        style={
          hasCode
            ? { gridTemplateColumns: `${cols}fr 6px ${100 - cols}fr` }
            : undefined
        }
      >
        <div
          className="col"
          style={
            hasCode && panels.length > 0
              ? { gridTemplateRows: `${leftRow}fr 6px ${100 - leftRow}fr` }
              : undefined
          }
        >
          <section
            className="text"
            ref={textPane}
            tabIndex={-1}
            aria-label="Lesson"
          >
            <p className="crumb">{page.lessonTitle}</p>
            <h2>{page.title}</h2>
            <div
              className="prose"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(page.markdown),
              }}
            />
          </section>
          {hasCode && panels.length > 0 ? (
            <>
              <Divider
                axis="horizontal"
                value={leftRow}
                label="Resize the lesson text and the message box"
                onChange={(value) => saveSplit("tour:left", setLeftRow, value)}
              />
              <section className="play" aria-label="Play">
                <div className="tabs" role="tablist" onKeyDown={tabKeys}>
                  {panels.map((tab) => {
                    return (
                      <button
                        type="button"
                        role="tab"
                        id={`play-tab-${tab}`}
                        key={tab}
                        aria-selected={play === tab}
                        aria-controls="play-panel"
                        tabIndex={play === tab ? 0 : -1}
                        onClick={() => setPlay(tab)}
                        aria-keyshortcuts={shortcutsOf(tab)}
                      >
                        {tabNames[tab]} <Kbd action={tab} />
                      </button>
                    );
                  })}
                </div>
                <div
                  className="panel"
                  role="tabpanel"
                  id="play-panel"
                  aria-labelledby={`play-tab-${play}`}
                >
                  {play === "message" && target ? (
                    <MessagePanel
                      target={target}
                      disabled={status.state !== "live"}
                    />
                  ) : null}
                  {play === "slack" ? <Slack /> : null}
                  {play === "github" ? <Github /> : null}
                  {play === "events" ? <Events /> : null}
                </div>
              </section>
            </>
          ) : null}
        </div>

        {hasCode ? (
          <>
            <Divider
              axis="vertical"
              value={cols}
              label="Resize the lesson and the code"
              low={25}
              high={70}
              onChange={(value) => saveSplit("tour:cols", setCols, value)}
            />
            <div
              className="col right"
              style={{
                gridTemplateRows: `${rightRow}fr 6px ${100 - rightRow}fr`,
              }}
            >
              <section className="work" aria-label="Code">
                <div className="tabs files" role="tablist" onKeyDown={tabKeys}>
                  {files.map((file) => {
                    return (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active === file.name}
                        tabIndex={active === file.name ? 0 : -1}
                        key={file.name}
                        onClick={() => setActive(file.name)}
                      >
                        {file.name}
                        {file.editable ? "" : " (read-only)"}
                        {file.name === "run.ts" ? (
                          <>
                            {" "}
                            <Kbd action="runEvent" />
                          </>
                        ) : null}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="ghost files-key"
                    onClick={nextFile}
                    aria-keyshortcuts={shortcutsOf("file")}
                  >
                    Next file <Kbd action="file" />
                  </button>
                </div>
                <Editor
                  ref={editor}
                  files={files}
                  active={active}
                  dark={dark}
                  markers={markers}
                  handlers={() => {
                    return latest.current;
                  }}
                  onChange={(name, content) => {
                    if (name === "agent.ts") {
                      store.set(editKey(page), content);
                    }
                  }}
                />
                <div className="controls">
                  <button
                    type="button"
                    className="primary"
                    ref={runButton}
                    onClick={run}
                    aria-keyshortcuts={shortcutsOf("run")}
                  >
                    Run <Kbd action="run" />
                  </button>
                  {live ? (
                    <button
                      type="button"
                      onClick={handlers.kill}
                      aria-keyshortcuts={shortcutsOf("kill")}
                    >
                      Kill <Kbd action="kill" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={handlers.format}
                    aria-keyshortcuts={shortcutsOf("format")}
                  >
                    Format <Kbd action="format" />
                  </button>
                  <button
                    type="button"
                    onClick={reset}
                    aria-keyshortcuts={shortcutsOf("reset")}
                  >
                    Reset <Kbd action="reset" />
                  </button>
                  {undo ? (
                    <button
                      type="button"
                      className="toast"
                      onClick={undoReset}
                      aria-keyshortcuts={shortcutsOf("undo")}
                    >
                      Undo reset <Kbd action="undo" />
                    </button>
                  ) : null}
                  <span className={`status-line ${status.state}`} role="status">
                    {status.text}
                  </span>
                </div>
              </section>
              <Divider
                axis="horizontal"
                value={rightRow}
                label="Resize the code and the trace"
                onChange={(value) =>
                  saveSplit("tour:right", setRightRow, value)
                }
              />
              <section className="tracepane" aria-label="Trace">
                <TracePanel
                  runs={runs}
                  lines={lines}
                  everything={everything}
                  onToggle={handlers.everything}
                />
              </section>
            </div>
          </>
        ) : null}
      </main>

      <footer className="pager">
        <button
          type="button"
          onClick={() => {
            go(-1);
          }}
          disabled={position <= 0}
          aria-keyshortcuts={shortcutsOf("prev")}
        >
          Previous <Kbd action="prev" />
        </button>
        <span className="counter">
          {page.number} / {flat.length}
        </span>
        <button
          type="button"
          className="primary"
          onClick={() => {
            go(1);
          }}
          aria-keyshortcuts={shortcutsOf("next")}
        >
          {position >= flat.length - 1 ? "Contents" : "Next"}{" "}
          <Kbd action="next" />
        </button>
      </footer>

      {overlay === "contents" ? (
        <Contents
          index={index}
          current={page.id}
          onPick={pick}
          onClose={() => {
            setOverlay(null);
          }}
        />
      ) : null}
      {overlay === "search" ? (
        <Search
          index={index}
          onPick={pick}
          onClose={() => {
            setOverlay(null);
          }}
        />
      ) : null}
      {overlay === "cheat" ? (
        <Cheat
          onClose={() => {
            setOverlay(null);
          }}
        />
      ) : null}
    </div>
  );
};
