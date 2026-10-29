/**
 * @module
 * The tour: lesson text on the left; the editor, the run controls and the
 * panels on the right; a bar to move between pages.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Page,
  PageSummary,
  TourEvent,
  TourIndex,
  TraceRun,
} from "../../shared/types.ts";
import { api } from "./api.ts";
import { addTypes, Editor, type EditorApi, type Marker } from "./Editor.tsx";
import { type Handlers, Kbd, shortcutsOf, useKeyboard } from "./keyboard.tsx";
import { renderMarkdown } from "./markdown.ts";
import { Cheat, Contents, Search } from "./overlays.tsx";
import { MessagePanel, OutputPanel, TracePanel } from "./panels.tsx";
import { hash, store } from "./platform.ts";

type Overlay = "contents" | "search" | "cheat" | null;
type Tab = "output" | "trace" | "message";
type Theme = "system" | "light" | "dark";
type Line = Extract<TourEvent, { type: "log" }>;
type Status = Extract<TourEvent, { type: "status" }>;

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
  const [tab, setTab] = useState<Tab>("trace");
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
  const [panelHeight, setPanelHeight] = useState(
    Number(store.get("tour:panel")) || 260,
  );
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
    void api.types().then(addTypes);

    return api.stream((event) => {
      if (event.type === "log") {
<<<<<<< HEAD
        setLines((previous) => {
          return [...previous, event];
        });
=======
        setLines((previous) => [...previous, event]);
>>>>>>> origin/jack/agent-primitives
      } else if (event.type === "clear") {
        setLines([]);
      } else if (event.type === "status") {
        setStatus(event);
      } else if (event.type === "runs") {
        setRuns(event.runs);
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
      setTab((next.manifest.open as Tab | undefined) ?? "output");
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
    if (flat.length === 0) {
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
  }, [flat, open]);

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

  const run = () => {
    if (!page || !hasCode) {
      return;
    }

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

  const panels = (page?.manifest.panels ?? ["output", "trace"]) as Tab[];
  const showTab = (next: Tab) => {
    if (panels.includes(next)) {
      setTab(next);
    }
  };

  const handlers: Handlers = {
    run,
    kill: () => {
      void api.kill();
    },
    reset,
    format: () => {
      editor.current?.format();
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
    output: () => {
      showTab("output");
    },
    trace: () => {
      showTab("trace");
    },
    message: () => {
      showTab("message");
    },
    everything: () => {
<<<<<<< HEAD
      setEverything((value) => {
        return !value;
      });
=======
      setEverything((value) => !value);
>>>>>>> origin/jack/agent-primitives
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

  const dragPanel = (event: React.PointerEvent) => {
    const start = event.clientY;
    const from = panelHeight;
    const move = (next: PointerEvent) => {
      setPanelHeight(
        Math.max(120, Math.min(600, from + (start - next.clientY))),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!index || !page) {
    return <div className="loading">Loading the tour...</div>;
  }

  const target = page.manifest.message;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo" aria-hidden="true" />
        <h1>Agents Tour</h1>
        <nav>
          <button
            type="button"
            className="ghost"
<<<<<<< HEAD
            onClick={() => {
              setOverlay("contents");
            }}
=======
            onClick={() => setOverlay("contents")}
>>>>>>> origin/jack/agent-primitives
            aria-keyshortcuts={shortcutsOf("contents")}
          >
            Contents <Kbd action="contents" />
          </button>
          <button
            type="button"
            className="ghost"
<<<<<<< HEAD
            onClick={() => {
              setOverlay("search");
            }}
=======
            onClick={() => setOverlay("search")}
>>>>>>> origin/jack/agent-primitives
            aria-keyshortcuts={shortcutsOf("search")}
          >
            Search <Kbd action="search" />
          </button>
          <button
            type="button"
            className="ghost"
<<<<<<< HEAD
            onClick={() => {
              setOverlay("cheat");
            }}
=======
            onClick={() => setOverlay("cheat")}
>>>>>>> origin/jack/agent-primitives
            aria-keyshortcuts={shortcutsOf("cheat")}
          >
            Keys <Kbd action="cheat" />
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

      <main className={hasCode ? "split" : "single"}>
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
            dangerouslySetInnerHTML={{ __html: renderMarkdown(page.markdown) }}
          />
        </section>

        {hasCode ? (
          <section className="work" aria-label="Code and results">
            <div className="tabs files" role="tablist">
              {files.map((file) => {
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active === file.name}
                    key={file.name}
<<<<<<< HEAD
                    onClick={() => {
                      setActive(file.name);
                    }}
=======
                    onClick={() => setActive(file.name)}
>>>>>>> origin/jack/agent-primitives
                  >
                    {file.name}
                    {file.editable ? "" : " (read-only)"}
                  </button>
                );
              })}
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
            <div
              className="divider"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the panels"
              tabIndex={0}
              onPointerDown={dragPanel}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp") {
<<<<<<< HEAD
                  setPanelHeight((value) => {
                    return Math.min(600, value + 24);
                  });
                } else if (event.key === "ArrowDown") {
                  setPanelHeight((value) => {
                    return Math.max(120, value - 24);
                  });
=======
                  setPanelHeight((value) => Math.min(600, value + 24));
                } else if (event.key === "ArrowDown") {
                  setPanelHeight((value) => Math.max(120, value - 24));
>>>>>>> origin/jack/agent-primitives
                }
              }}
            />
            <div className="lower" style={{ height: panelHeight }}>
              <div className="tabs" role="tablist">
                {panels.includes("output") ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "output"}
<<<<<<< HEAD
                    onClick={() => {
                      setTab("output");
                    }}
=======
                    onClick={() => setTab("output")}
>>>>>>> origin/jack/agent-primitives
                    aria-keyshortcuts={shortcutsOf("output")}
                  >
                    Output <Kbd action="output" />
                  </button>
                ) : null}
                {panels.includes("trace") ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "trace"}
<<<<<<< HEAD
                    onClick={() => {
                      setTab("trace");
                    }}
=======
                    onClick={() => setTab("trace")}
>>>>>>> origin/jack/agent-primitives
                    aria-keyshortcuts={shortcutsOf("trace")}
                  >
                    Trace <Kbd action="trace" />
                  </button>
                ) : null}
                {panels.includes("message") ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "message"}
<<<<<<< HEAD
                    onClick={() => {
                      setTab("message");
                    }}
=======
                    onClick={() => setTab("message")}
>>>>>>> origin/jack/agent-primitives
                    aria-keyshortcuts={shortcutsOf("message")}
                  >
                    Message <Kbd action="message" />
                  </button>
                ) : null}
              </div>
              <div className="panel" role="tabpanel">
                {tab === "output" ? <OutputPanel lines={lines} /> : null}
                {tab === "trace" ? (
                  <TracePanel
                    runs={runs}
                    everything={everything}
                    onToggle={handlers.everything}
                    hint={<Kbd action="everything" />}
                  />
                ) : null}
                {tab === "message" && target ? (
                  <MessagePanel
                    target={target}
                    disabled={status.state !== "live"}
                  />
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
      </main>

      <footer className="pager">
        <button
          type="button"
<<<<<<< HEAD
          onClick={() => {
            go(-1);
          }}
=======
          onClick={() => go(-1)}
>>>>>>> origin/jack/agent-primitives
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
<<<<<<< HEAD
          onClick={() => {
            go(1);
          }}
=======
          onClick={() => go(1)}
>>>>>>> origin/jack/agent-primitives
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
<<<<<<< HEAD
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
=======
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {overlay === "search" ? (
        <Search index={index} onPick={pick} onClose={() => setOverlay(null)} />
      ) : null}
      {overlay === "cheat" ? <Cheat onClose={() => setOverlay(null)} /> : null}
>>>>>>> origin/jack/agent-primitives
    </div>
  );
};
