/**
 * @module
 * The tour: lesson text on the left; the editor, the run controls and the
 * panels on the right; a bar to move between pages.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { coreKeys } from "../../shared/keys/core.ts";
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
import { EventBlock } from "./EventBlock.tsx";
import { clearEdits, saveEdits, withEdits } from "./edits.ts";
import { type Handlers, Kbd, shortcutsOf, useKeyboard } from "./keyboard.tsx";
import { panelKeys } from "./keytable.ts";
import { sendAction } from "./live.ts";
import { renderMarkdown } from "./markdown.ts";
import { Cheat, Contents, Search } from "./overlays.tsx";
import { allPanels, type PanelDef, panelOf } from "./panels/index.ts";
import { Divider } from "./panes.tsx";
import { store } from "./platform.ts";
import { routeStreamEvent } from "./stream.ts";
import { TracePanel } from "./trace.tsx";

type Overlay = "contents" | "search" | "cheat" | null;
type Line = Extract<TourEvent, { type: "log" }>;
type Status = Extract<TourEvent, { type: "status" }>;

const pathOf = (id: string) => {
  return `/tour/${id}`;
};

const idFromPath = () => {
  const match = /^\/tour\/(.+)$/.exec(window.location.pathname);

  return match?.[1];
};

type CoreId = (typeof coreKeys)[number]["id"];

export const App = () => {
  const [index, setIndex] = useState<TourIndex>();
  const [page, setPage] = useState<Page>();
  const [files, setFiles] = useState<Page["files"]>([]);
  const [active, setActive] = useState("");
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
  const [cols, setCols] = useState(Number(store.get("tour:cols")) || 42);
  const [leftRow, setLeftRow] = useState(Number(store.get("tour:left")) || 58);
  const [rightRow, setRightRow] = useState(
    Number(store.get("tour:right")) || 56,
  );
  const [play, setPlay] = useState<string>("message");
  const [undo, setUndo] = useState<Record<string, string> | null>(null);
  const editor = useRef<EditorApi>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const textPane = useRef<HTMLElement>(null);
  const undoTimer = useRef<number | undefined>(undefined);

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
      } else {
        routeStreamEvent(event, window);
      }
    });
  }, []);

  const flat = useMemo(() => {
    return (
      index?.modules.flatMap((module) => {
        return module.pages;
      }) ?? []
    );
  }, [index]);

  const open = useCallback((id: string, push = true) => {
    void api.page(id).then((next) => {
      const loaded = withEdits(next, store);

      void api.open(next.id);
      setPage(next);
      setFiles(loaded);
      setActive(next.files[0]?.name ?? "");
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

  const coreCount = flat.filter((entry) => {
    return entry.kind === "core";
  }).length;
  const hasCode = page?.manifest.code !== false;
  const live = runs.some((run) => {
    return !["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(
      run.status,
    );
  });

  // Formats every editable file with the repo's Biome.
  const formatAll = async () => {
    for (const file of page?.files ?? []) {
      const current = editor.current?.values()[file.name];

      if (file.editable && current !== undefined) {
        editor.current?.replace(
          file.name,
          await api.format(file.name, current),
        );
      }
    }
  };

  const run = async () => {
    if (!page || !hasCode) {
      return;
    }

    await formatAll();

    const values = editor.current?.values() ?? {};

    saveEdits(page, values, store);
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

    clearEdits(page, store);
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

  const nextFile = () => {
    const at = files.findIndex((file) => {
      return file.name === active;
    });
    const next = files[(at + 1) % Math.max(1, files.length)];

    if (next) {
      setActive(next.name);
    }
  };

  const messageTarget = page?.manifest.message;
  const tabs = (
    page?.manifest.panels ?? (messageTarget ? ["message"] : [])
  ).flatMap((id) => {
    return panelOf(id) ?? [];
  });
  const tabsKey = tabs
    .map((tab) => {
      return tab.id;
    })
    .join(",");
  const Panel = panelOf(play)?.component;

  useEffect(() => {
    setPlay(tabsKey.split(",")[0] ?? "");
  }, [page?.id, tabsKey]);

  // Opens a tab of the play pane, then focuses something in it.
  const focusTab = (tab: PanelDef) => {
    setPlay(tab.id);
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(tab.focus)?.focus();
    }, 40);
  };

  // Opens a tab, then hands a key action to its panel once it is on screen.
  const forwardTo = (tab: PanelDef, action: ActionId) => {
    setPlay(tab.id);
    window.setTimeout(() => {
      sendAction(action);
    }, 40);
  };

  const focusIn = (selector: string) => {
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(selector)?.focus();
    }, 0);
  };

  // Each panel's tab key opens it. A key a panel lists in `panels` opens the
  // tab and is handed on; one several panels list goes to the open panel
  // first.
  const panelHandlers: Handlers = {};

  for (const def of allPanels()) {
    panelHandlers[def.id] = () => {
      if (tabs.includes(def)) {
        focusTab(def);
      }
    };

    for (const key of panelKeys(def.id)) {
      panelHandlers[key.id] = () => {
        const owners = tabs.filter((tab) => {
          return key.panels?.includes(tab.id);
        });
        const owner =
          owners.find((tab) => {
            return tab.id === play;
          }) ?? owners[0];

        if (owner) {
          forwardTo(owner, key.id);
        }
      };
    }
  }

  const core: Record<CoreId, () => void> = {
    run,
    kill: () => {
      void api.kill();
    },
    reset,
    format: () => {
      void formatAll();
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
    file: nextFile,
    devserver: () => {
      if (devServerUrl) {
        window.open(devServerUrl, "_blank", "noopener");
      }
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
  };
  const handlers: Handlers = { ...panelHandlers, ...core };
  const latest = useRef(handlers);

  latest.current = handlers;
  useKeyboard(handlers, () => {
    return overlay !== null;
  });

  const markers: Marker[] = useMemo(() => {
    const out: Marker[] = [];

    for (const line of lines) {
      for (const file of files) {
        const match = new RegExp(
          `${file.name.replace(".", "\\.")}:(\\d+)`,
        ).exec(line.text);

        if (file.editable && line.kind === "err" && match) {
          out.push({
            file: file.name,
            line: Number(match[1]),
            message: line.text,
          });
        }
      }
    }

    return out;
  }, [lines, files]);

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
            title="Opens the Dev Server dashboard, which shows the same runs as the Trace pane."
            aria-keyshortcuts={shortcutsOf("devserver")}
          >
            Dev Server <Kbd action="devserver" />
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
            hasCode && tabs.length > 0
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
            <p className="crumb">{page.moduleTitle}</p>
            <h2>{page.title}</h2>
            <div
              className="prose"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(page.markdown),
              }}
            />
            {hasCode && page.manifest.start?.length ? (
              <EventBlock starts={page.manifest.start} />
            ) : null}
          </section>
          {hasCode && tabs.length > 0 ? (
            <>
              <Divider
                axis="horizontal"
                value={leftRow}
                label="Resize the lesson text and the message box"
                onChange={(value) => saveSplit("tour:left", setLeftRow, value)}
              />
              <section className="play" aria-label="Play">
                <div className="tabs" role="tablist" onKeyDown={tabKeys}>
                  {tabs.map((tab) => {
                    return (
                      <button
                        type="button"
                        role="tab"
                        id={`play-tab-${tab.id}`}
                        key={tab.id}
                        aria-selected={play === tab.id}
                        aria-controls="play-panel"
                        tabIndex={play === tab.id ? 0 : -1}
                        onClick={() => setPlay(tab.id)}
                        aria-keyshortcuts={shortcutsOf(tab.id)}
                      >
                        {tab.label} <Kbd action={tab.id} />
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
                  {Panel && page ? (
                    <Panel page={page} live={status.state === "live"} />
                  ) : null}
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
                  markers={markers}
                  handlers={() => {
                    return latest.current;
                  }}
                  onChange={(name, content) => {
                    saveEdits(page, { [name]: content }, store);
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
                  onToggle={() => {
                    handlers.everything?.();
                  }}
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
          {page.label} / {coreCount}
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
