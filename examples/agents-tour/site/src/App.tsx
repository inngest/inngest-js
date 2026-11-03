/**
 * @module
 * The tour: lesson text on the left; the editor, the run controls and the
 * panels on the right; a bar to move between pages.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { coreKeys } from "../../shared/keys/core.ts";
import type { ActionId } from "../../shared/keys.ts";
import { resolveSpan } from "../../shared/links.ts";
import type {
  Page,
  PageSummary,
  ProgressSnapshot,
  TourEvent,
  TourIndex,
  TraceRun,
} from "../../shared/types.ts";
import { api } from "./api.ts";
import { addTypes, Editor, type EditorApi, type Marker } from "./Editor.tsx";
import { EventBlock } from "./EventBlock.tsx";
import { Exercise } from "./Exercise.tsx";
import { clearEdits, saveEdits, withEdits } from "./edits.ts";
import { type Handlers, Kbd, shortcutsOf, useKeyboard } from "./keyboard.tsx";
import { panelKeys } from "./keytable.ts";
import { sendAction } from "./live.ts";
import { renderMarkdown } from "./markdown.ts";
import { Nav } from "./Nav.tsx";
import { Concepts, Deeper, Search } from "./overlays.tsx";
import { allPanels, type PanelDef, panelOf } from "./panels/index.ts";
import { Divider } from "./panes.tsx";
import { store } from "./platform.ts";
import { flyConcepts, moment } from "./progress-effects.ts";
import { deeperWaiting, moduleEnd } from "./progress-model.ts";
import { routeStreamEvent } from "./stream.ts";
import { type RunPressed, TracePanel } from "./trace.tsx";

type Overlay = "concepts" | "deeper" | "search" | null;

const noProgress: ProgressSnapshot = {
  pages: {},
  concepts: {},
  totalConcepts: 0,
};
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBox = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [runs, setRuns] = useState<TraceRun[]>([]);
  const [status, setStatus] = useState<Status>({
    type: "status",
    state: "idle",
    text: "Connecting...",
  });
  const [everything, setEverything] = useState(false);
  // Set the moment Run is pressed, so the Trace can show a placeholder run.
  const [runSignal, setPressed] = useState<RunPressed | null>(null);
  const [cols, setCols] = useState(Number(store.get("tour:cols")) || 42);
  const [leftRow, setLeftRow] = useState(Number(store.get("tour:left")) || 58);
  const [rightRow, setRightRow] = useState(
    Number(store.get("tour:right")) || 56,
  );
  const [play, setPlay] = useState<string>("message");
  const [edits, setEdits] = useState(0);
  const [progress, setProgress] = useState<ProgressSnapshot>(noProgress);
  const [rail, setRail] = useState(store.get("tour:rail") === "1");
  const [moduleDone, setModuleDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Under 900px the nav is a rail, and the whole nav opens over the page.
  const [narrow, setNarrow] = useState(() => {
    return window.matchMedia("(max-width: 900px)").matches;
  });

  const [navOpen, setNavOpen] = useState(false);
  // The runs on screen when Run was pressed, so only a newer finished run
  // counts as the run having finished.
  const pressed = useRef<{ page: string; before: Set<string> } | null>(null);
  const [undo, setUndo] = useState<Record<string, string> | null>(null);
  const editor = useRef<EditorApi>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const textPane = useRef<HTMLElement>(null);
  const undoTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");

    const onChange = () => {
      setNarrow(query.matches);
      setNavOpen(false);
    };

    query.addEventListener("change", onChange);

    return () => {
      query.removeEventListener("change", onChange);
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

    const refresh = () => {
      void api.progress().then(setProgress);
    };

    refresh();

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
      } else if (event.type === "progress") {
        refresh();

        if (event.mark.collected.length > 0) {
          flyConcepts(event.mark.collected);
        }

        if (event.mark.moduleDone) {
          setModuleDone(event.mark.moduleDone);
          moment("moduleDone");
        }
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
      void api.mark(next.id, "opened");
      setModuleDone(null);
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
    }
  };

  const here = flat[position];
  const waiting = useMemo(() => {
    return index ? deeperWaiting(index, progress.pages) : [];
  }, [index, progress]);

  const end = index && page ? moduleEnd(index, page.id) : null;

  const doneModule = index?.modules.find((module) => {
    return module.id === moduleDone;
  });

  const deeperLeft = waiting.filter((entry) => {
    return entry.module === moduleDone;
  }).length;

  // The banner offers the same two buttons as the end of the module, whichever
  // page the reader is on.
  const doneEnd =
    index && doneModule
      ? moduleEnd(
          index,
          doneModule.pages
            .filter((entry) => {
              return entry.kind === "core";
            })
            .at(-1)?.id ?? "",
        )
      : null;

  const showRail = narrow || rail;

  const toggleRail = () => {
    if (narrow) {
      setNavOpen((value) => {
        return !value;
      });

      return;
    }

    setRail((value) => {
      store.set("tour:rail", value ? "0" : "1");

      return !value;
    });
  };

  const openNav = () => {
    if (narrow) {
      setNavOpen(true);
    } else {
      setRail(false);
      store.set("tour:rail", "0");
    }
  };

  // Focuses the current page in the nav, or the first item when the current
  // page is not shown.
  const focusNav = () => {
    openNav();
    window.setTimeout(() => {
      const nav = document.querySelector<HTMLElement>(".nav:not(.rail)");

      (
        nav?.querySelector<HTMLElement>('[aria-current="page"]') ??
        nav?.querySelector<HTMLElement>("[data-nav-item]")
      )?.focus();
    }, 40);
  };

  const askReset = () => {
    if (showRail) {
      openNav();
    }

    if (!confirming) {
      setConfirming(true);
      window.setTimeout(() => {
        setConfirming(false);
      }, 4000);

      return;
    }

    setConfirming(false);
    void api.resetProgress();
  };

  const conceptCount = Object.keys(progress.concepts).length;

  const coreCount = flat.filter((entry) => {
    return entry.kind === "core";
  }).length;
  const hasCode = page?.manifest.code !== false;
  const live = runs.some((run) => {
    return !["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(
      run.status,
    );
  });

  // A page has "ran" once the run Run started has finished.
  useEffect(() => {
    const started = pressed.current;

    const fresh = runs.filter((entry) => {
      return !started?.before.has(entry.id);
    });

    if (started && started.page === page?.id && fresh.length > 0 && !live) {
      pressed.current = null;
      void api.mark(started.page, "ran");
    }
  }, [runs, live, page?.id]);

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

    setPressed({
      at: Date.now(),
      label: page.files.some((file) => file.name === "run.ts")
        ? "run.ts"
        : null,
    });
    await formatAll();

    const values = editor.current?.values() ?? {};

    saveEdits(page, values, store);
    void api.run(page.id, values).catch(() => {
      setPressed(null);
    });

    pressed.current = {
      page: page.id,
      before: new Set(
        runs.map((entry) => {
          return entry.id;
        }),
      ),
    };

    editor.current?.focus();
  };

  const checkExercise = async () => {
    if (!page) {
      return { pass: false as const, reason: "No page is open." };
    }

    await formatAll();

    const values = editor.current?.values() ?? {};

    saveEdits(page, values, store);

    return api.check(page.id, values);
  };

  const showSolution = async () => {
    if (!page) {
      return;
    }

    const before = editor.current?.values() ?? {};

    for (const file of await api.solution(page.id)) {
      editor.current?.setValue(file.name, file.content);
    }

    setUndo(before);
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => {
      setUndo(null);
    }, 10_000);
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

  // Opens the code a linked span of the text names, found in the editor's
  // current content; nothing happens when it no longer matches.
  const openCode = (span: string) => {
    const values = editor.current?.values() ?? {};
    const target = resolveSpan(
      span,
      files.map((file) => {
        return { name: file.name, content: values[file.name] ?? file.content };
      }),
    );

    if (!target) {
      return;
    }

    setActive(target.file);

    if (target.line > 0) {
      editor.current?.reveal(target);
    }
  };

  const onProseClick = (event: React.MouseEvent<HTMLElement>) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>(
      "code.code-link",
    );

    if (link?.dataset.code) {
      openCode(link.dataset.code);
    }
  };

  const onProseKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;

    if (event.key === "Enter" && target.matches("code.code-link")) {
      event.preventDefault();
      openCode(target.dataset.code ?? "");
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
    contents: focusNav,
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
    editor: toggleEditor,
    undo: undoReset,
  };
  // The exercise controls listen for these; see `Exercise.tsx`.
  const exerciseHandlers: Handlers = {
    check: () => {
      sendAction("check");
    },
    hint: () => {
      sendAction("hint");
    },
    solution: () => {
      sendAction("solution");
    },
  };
  const progressHandlers: Handlers = {
    nextModule: () => {
      if (end?.nextModule) {
        open(end.nextModule.id);
      }
    },
    goDeeper: () => {
      if (end?.deeper) {
        open(end.deeper.id);
      }
    },
    deeperList: () => {
      setOverlay("deeper");
    },
    dismiss: () => {
      if (navOpen) {
        setNavOpen(false);
      } else {
        setModuleDone(null);
      }
    },
  };

  const handlers: Handlers = {
    ...panelHandlers,
    ...progressHandlers,
    ...(page?.manifest.exercise ? exerciseHandlers : {}),
    ...core,
  };

  const latest = useRef(handlers);

  latest.current = handlers;
  useKeyboard(handlers, () => {
    return overlay !== null || menuOpen;
  });

  // The stack menu closes on a click outside it or on Escape.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const onDown = (event: MouseEvent) => {
      if (!menuBox.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

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
    setNavOpen(false);
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
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <h1>Agents Tour</h1>
        </div>
        <button
          type="button"
          className="concepts-bar"
          id="concepts-chip"
          tabIndex={-1}
          onClick={() => {
            setOverlay("concepts");
          }}
          title="Open the concepts you have collected"
        >
          <span
            className="concepts-track"
            role="progressbar"
            aria-label="Concepts collected"
            aria-valuemin={0}
            aria-valuemax={progress.totalConcepts}
            aria-valuenow={conceptCount}
          >
            <span
              className="concepts-fill"
              style={{
                width: `${progress.totalConcepts ? Math.min(100, (conceptCount / progress.totalConcepts) * 100) : 0}%`,
              }}
            />
          </span>
          <span className="concepts-label">
            {conceptCount} of {progress.totalConcepts} concepts
          </span>
        </button>
        <nav>
          {waiting.length > 0 ? (
            <button
              type="button"
              className="chip"
              id="deeper-chip"
              onClick={() => {
                setOverlay("deeper");
              }}
              aria-keyshortcuts={shortcutsOf("deeperList")}
            >
              {waiting.length} deeper {waiting.length === 1 ? "page" : "pages"}{" "}
              waiting <Kbd action="deeperList" />
            </button>
          ) : null}
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
          <div className="stack-menu" ref={menuBox}>
            <button
              type="button"
              className="ghost stack-button"
              tabIndex={-1}
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                setMenuOpen((value) => {
                  return !value;
                });
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3 3 8l9 5 9-5-9-5Z" />
                <path d="m3 12 9 5 9-5" />
                <path d="m3 16 9 5 9-5" />
              </svg>
            </button>
            {menuOpen ? (
              <div className="stack-popover" role="menu">
                <a
                  role="menuitem"
                  tabIndex={-1}
                  href={devServerUrl || undefined}
                  target="_blank"
                  rel="noopener"
                  title="Opens the Dev Server dashboard, which shows the same runs as the Trace pane."
                  onClick={() => {
                    setMenuOpen(false);
                  }}
                >
                  Dev Server
                </a>
              </div>
            ) : null}
          </div>
        </nav>
      </header>

      <div className="body" data-rail={showRail}>
        <Nav
          index={index}
          progress={progress}
          current={here}
          rail={showRail}
          confirming={confirming}
          onPick={pick}
          onToggle={toggleRail}
          onReset={askReset}
        />
        {narrow && navOpen ? (
          <div
            className="nav-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setNavOpen(false);
              }
            }}
          >
            <Nav
              index={index}
              progress={progress}
              current={here}
              rail={false}
              confirming={confirming}
              onPick={pick}
              onToggle={toggleRail}
              onReset={askReset}
            />
          </div>
        ) : null}
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
              <p className="crumb" key={`crumb-${page.id}`}>
                {page.moduleTitle}
              </p>
              <h2 key={`title-${page.id}`}>{page.title}</h2>
              <div
                key={`prose-${page.id}`}
                className="prose"
                onClick={onProseClick}
                onKeyDown={onProseKey}
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(page.markdown, page.files),
                }}
              />
              {page.manifest.apis?.length || page.manifest.concepts?.length ? (
                <ul
                  className="pills"
                  key={`pills-${page.id}`}
                  aria-label="New on this page"
                >
                  {(page.manifest.apis ?? []).map((api) => {
                    return (
                      <li key={`api-${api}`} className="pill api">
                        <code>{api}</code>
                      </li>
                    );
                  })}
                  {(page.manifest.concepts ?? []).map((concept) => {
                    return (
                      <li key={`concept-${concept}`}>
                        <button
                          type="button"
                          className="pill"
                          title="Open the concepts you have collected"
                          onClick={() => setOverlay("concepts")}
                        >
                          {concept}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {hasCode && page.manifest.exercise ? (
                <Exercise
                  key={page.id}
                  hint={page.manifest.exercise.hint}
                  check={checkExercise}
                  showSolution={showSolution}
                  edits={edits}
                />
              ) : null}
              {hasCode && page.manifest.start?.length ? (
                <EventBlock key={page.id} starts={page.manifest.start} />
              ) : null}
            </section>
            {hasCode && tabs.length > 0 ? (
              <>
                <Divider
                  axis="horizontal"
                  value={leftRow}
                  label="Resize the lesson text and the message box"
                  onChange={(value) =>
                    saveSplit("tour:left", setLeftRow, value)
                  }
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
                  <div
                    className="tabs files"
                    role="tablist"
                    onKeyDown={tabKeys}
                  >
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
                      setEdits((count) => {
                        return count + 1;
                      });
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
                    <span
                      className={`status-line ${status.state}`}
                      role="status"
                    >
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
                      setEverything((value) => {
                        return !value;
                      });
                    }}
                    pressed={runSignal}
                  />
                </section>
              </div>
            </>
          ) : null}
        </main>
      </div>

      {doneModule ? (
        <div className="module-done" role="status">
          <strong>{doneModule.title} is done.</strong>
          <span>
            The exercise passed.
            {deeperLeft > 0
              ? ` ${deeperLeft} deeper ${deeperLeft === 1 ? "page" : "pages"} waiting.`
              : ""}
          </span>
          {doneEnd?.deeper ? (
            <button
              type="button"
              onClick={() => {
                if (doneEnd?.deeper) {
                  open(doneEnd.deeper.id);
                }
              }}
              aria-keyshortcuts={shortcutsOf("goDeeper")}
            >
              Go deeper <Kbd action="goDeeper" />
            </button>
          ) : null}
          {doneEnd?.nextModule ? (
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (doneEnd?.nextModule) {
                  open(doneEnd.nextModule.id);
                }
              }}
              aria-keyshortcuts={shortcutsOf("nextModule")}
            >
              Next module <Kbd action="nextModule" />
            </button>
          ) : null}
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setModuleDone(null);
            }}
          >
            Dismiss <Kbd action="dismiss" />
          </button>
        </div>
      ) : null}

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
        {end?.deeper ? (
          <button
            type="button"
            onClick={handlers.goDeeper}
            aria-keyshortcuts={shortcutsOf("goDeeper")}
          >
            Go deeper <Kbd action="goDeeper" />
          </button>
        ) : null}
        {end?.nextModule ? (
          <button
            type="button"
            onClick={handlers.nextModule}
            aria-keyshortcuts={shortcutsOf("nextModule")}
          >
            Next module <Kbd action="nextModule" />
          </button>
        ) : null}
        <button
          type="button"
          className="primary"
          onClick={() => {
            go(1);
          }}
          disabled={position >= flat.length - 1}
          aria-keyshortcuts={shortcutsOf("next")}
        >
          Next <Kbd action="next" />
        </button>
      </footer>

      {overlay === "concepts" ? (
        <Concepts
          index={index}
          progress={progress}
          onPick={pick}
          onClose={() => {
            setOverlay(null);
          }}
        />
      ) : null}
      {overlay === "deeper" ? (
        <Deeper
          index={index}
          waiting={waiting}
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
    </div>
  );
};
