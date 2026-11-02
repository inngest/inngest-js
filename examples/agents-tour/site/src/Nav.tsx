/**
 * @module
 * The left nav: every module and page, always on screen. A module opens and
 * closes; each page shows its state, the exercise a star, and Go deeper pages
 * sit under their module marked as deeper. It collapses to a slim rail.
 * Arrow keys move through it, Left and Right close and open a module.
 */
import { useEffect, useRef, useState } from "react";
import type {
  PageSummary,
  ProgressSnapshot,
  TourIndex,
} from "../../shared/types.ts";
import { Kbd, shortcutsOf } from "./keyboard.tsx";
import { moduleRow, stateOf } from "./progress-model.ts";

const symbolOf = (page: PageSummary) => {
  return page.exercise ? "★" : "";
};

export const Nav = ({
  index,
  progress,
  current,
  rail,
  onPick,
  onToggle,
  confirming,
  onReset,
}: {
  index: TourIndex;
  progress: ProgressSnapshot;
  current: PageSummary | undefined;
  rail: boolean;
  onPick: (page: PageSummary) => void;
  onToggle: () => void;
  // True after the first press of Reset progress; the next one resets.
  confirming: boolean;
  onReset: () => void;
}) => {
  // Only the module the reader is in starts open.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const box = useRef<HTMLElement>(null);
  const currentModule = current?.module;

  // Moving to a module opens it.
  useEffect(() => {
    if (currentModule) {
      setOpened((before) => {
        return new Set(before).add(currentModule);
      });
    }
  }, [currentModule]);

  // The current page is always in view.
  const currentId = current?.id;

  useEffect(() => {
    if (!rail && currentId) {
      box.current
        ?.querySelector<HTMLElement>('[aria-current="page"]')
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [rail, currentId, opened]);

  const flip = (id: string, open: boolean) => {
    setOpened((before) => {
      const next = new Set(before);

      if (open) {
        next.add(id);
      } else {
        next.delete(id);
      }

      return next;
    });
  };

  const items = () => {
    return [
      ...(box.current?.querySelectorAll<HTMLElement>("[data-nav-item]") ?? []),
    ];
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const all = items();
    const at = all.indexOf(target);
    const module = target.dataset.module;

    if (at < 0 || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      all[Math.min(all.length - 1, at + 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      all[Math.max(0, at - 1)]?.focus();
    } else if (event.key === "ArrowLeft" && module) {
      event.preventDefault();
      flip(module, false);

      if (target.dataset.kind === "page") {
        box.current
          ?.querySelector<HTMLElement>(
            `[data-kind=module][data-module="${module}"]`,
          )
          ?.focus();
      }
    } else if (event.key === "ArrowRight" && module) {
      event.preventDefault();
      flip(module, true);
    }
  };

  if (rail) {
    return (
      <nav className="nav rail" aria-label="Contents" ref={box}>
        <button
          type="button"
          className="ghost nav-toggle"
          onClick={onToggle}
          title="Open the left nav"
          aria-label="Open the left nav"
          aria-keyshortcuts={shortcutsOf("navToggle")}
        >
          &raquo;
          <Kbd action="navToggle" short />
        </button>
        {index.modules.map((module, at) => {
          const row = moduleRow(module, progress.pages);

          return (
            <button
              type="button"
              key={module.id}
              className="rail-module"
              data-nav-item=""
              data-done={row.done}
              aria-current={module.id === currentModule}
              title={`${module.title}: ${row.reached} of ${row.core} pages`}
              onClick={() => {
                const first = module.pages[0];

                if (first) {
                  onPick(first);
                }
              }}
            >
              {at + 1}
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="nav" aria-label="Contents" ref={box} onKeyDown={onKeyDown}>
      <div className="nav-head">
        <h2>Contents</h2>
        <button
          type="button"
          className="ghost nav-toggle"
          onClick={onToggle}
          title="Collapse the left nav"
          aria-label="Collapse the left nav"
          aria-keyshortcuts={shortcutsOf("navToggle")}
        >
          &laquo; <Kbd action="navToggle" />
        </button>
      </div>
      <div className="nav-scroll">
        {index.modules.map((module, at) => {
          const row = moduleRow(module, progress.pages);
          const open = opened.has(module.id);

          return (
            <section
              key={module.id}
              className="nav-module"
              data-done={row.done}
            >
              <button
                type="button"
                className="nav-module-title"
                data-nav-item=""
                data-kind="module"
                data-module={module.id}
                aria-expanded={open}
                onClick={() => {
                  flip(module.id, !open);
                }}
              >
                <span className="twist" aria-hidden="true">
                  {open ? "▾" : "▸"}
                </span>
                <span className="module-name">
                  {at + 1}. {module.title}
                </span>
                <span className="module-count">
                  {row.reached}/{row.core}
                </span>
                <span
                  className="module-fill"
                  style={{
                    width: `${row.core === 0 ? 0 : (row.reached / row.core) * 100}%`,
                  }}
                  aria-hidden="true"
                />
              </button>
              {open ? (
                <>
                  <p className="module-opening">{module.opening}</p>
                  <ul>
                    {module.pages.map((page) => {
                      const state = stateOf(progress.pages, page.id);

                      return (
                        <li key={page.id}>
                          <button
                            type="button"
                            className="nav-page"
                            data-nav-item=""
                            data-kind="page"
                            data-module={module.id}
                            data-state={state}
                            data-deeper={page.kind === "deeper"}
                            aria-current={
                              page.id === current?.id ? "page" : undefined
                            }
                            onClick={() => {
                              onPick(page);
                            }}
                          >
                            <span
                              className="sym"
                              data-star={page.exercise}
                              role="img"
                              aria-label={
                                state === "none" ? "not opened" : state
                              }
                            >
                              {symbolOf(page)}
                            </span>
                            <span className="num">{page.label}</span>
                            <span className="title">{page.title}</span>
                            {page.kind === "deeper" ? (
                              <span className="deeper-tag">deeper</span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
            </section>
          );
        })}
      </div>
      <div className="nav-foot">
        <button
          type="button"
          className="ghost"
          onClick={onReset}
          aria-keyshortcuts={shortcutsOf("resetProgress")}
        >
          {confirming ? "Press again to reset" : "Reset progress"}{" "}
          <Kbd action="resetProgress" />
        </button>
      </div>
    </nav>
  );
};
