/**
 * @module
 * Overlays: the concepts, the deeper pages, the page search and the cheat
 * sheet. Each takes
 * focus when it opens and gives it back when it closes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { hintOf, monacoOnly } from "../../shared/keys.ts";
import type {
  PageSummary,
  ProgressSnapshot,
  TourIndex,
} from "../../shared/types.ts";
import { keys } from "./keytable.ts";
import { isMac } from "./platform.ts";

const Modal = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) => {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const focusable = box.current?.querySelector<HTMLElement>(
      "input, button, [tabindex]",
    );

    (focusable ?? box.current)?.focus();

    return () => {
      before?.focus();
    };
  }, []);

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={box}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
};

export const Concepts = ({
  index,
  progress,
  onPick,
  onClose,
}: {
  index: TourIndex;
  progress: ProgressSnapshot;
  onPick: (page: PageSummary) => void;
  onClose: () => void;
}) => {
  const pages = index.modules.flatMap((module) => {
    return module.pages;
  });
  const names = Object.keys(progress.concepts).sort();

  return (
    <Modal title="Concepts" onClose={onClose}>
      <p className="modal-hint">
        {names.length} of {progress.totalConcepts} collected. A concept joins
        the collection the first time a page introduces it.
      </p>
      <div className="concept-list">
        {names.map((name) => {
          const entry = progress.concepts[name];
          const taught = pages.find((page) => {
            return page.id === entry?.page;
          });

          return (
            <div className="concept" key={name}>
              <span className="pill">{name}</span>
              <p>{entry?.definition}</p>
              {taught ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    onPick(taught);
                  }}
                >
                  Taught on page {taught.label}: {taught.title}
                </button>
              ) : null}
            </div>
          );
        })}
        {names.length === 0 ? (
          <p className="empty">Nothing collected yet.</p>
        ) : null}
      </div>
      <p className="modal-hint">
        <kbd>Esc</kbd> closes this list.
      </p>
    </Modal>
  );
};

export const Deeper = ({
  index,
  waiting,
  onPick,
  onClose,
}: {
  index: TourIndex;
  waiting: PageSummary[];
  onPick: (page: PageSummary) => void;
  onClose: () => void;
}) => {
  return (
    <Modal title="Deeper pages waiting" onClose={onClose}>
      <p className="modal-hint">
        Optional pages from modules you have finished or left. Nothing on a core
        page depends on them.
      </p>
      <div className="contents">
        {index.modules.map((module) => {
          const own = waiting.filter((page) => {
            return page.module === module.id;
          });

          return own.length > 0 ? (
            <section key={module.id}>
              <h3>{module.title}</h3>
              {own.map((page) => {
                return (
                  <button
                    type="button"
                    className="entry"
                    key={page.id}
                    onClick={() => {
                      onPick(page);
                    }}
                  >
                    <span className="num">{page.label}</span>
                    {page.title}
                  </button>
                );
              })}
            </section>
          ) : null;
        })}
        {waiting.length === 0 ? (
          <p className="empty">No deeper pages waiting.</p>
        ) : null}
      </div>
    </Modal>
  );
};

export const Search = ({
  index,
  onPick,
  onClose,
}: {
  index: TourIndex;
  onPick: (page: PageSummary) => void;
  onClose: () => void;
}) => {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    return index.modules
      .flatMap((module) => {
        return module.pages;
      })
      .filter((page) => {
        const text =
          `${page.label} ${page.title} ${page.moduleTitle}`.toLowerCase();

        return words.every((word) => {
          return text.includes(word);
        });
      });
  }, [index, query]);

  return (
    <Modal title="Search pages" onClose={onClose}>
      <input
        className="search-input"
        value={query}
        placeholder="Page title or number"
        aria-label="Search pages"
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(0);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ArrowDown" ||
            (event.ctrlKey && event.key === "n")
          ) {
            event.preventDefault();
            setCursor((value) => {
              return Math.min(results.length - 1, value + 1);
            });
          } else if (
            event.key === "ArrowUp" ||
            (event.ctrlKey && event.key === "p")
          ) {
            event.preventDefault();
            setCursor((value) => {
              return Math.max(0, value - 1);
            });
          } else if (event.key === "Enter") {
            event.preventDefault();
            const page = results[cursor];

            if (page) {
              onPick(page);
            }
          }
        }}
      />
      <div className="contents">
        {results.map((page, position) => {
          return (
            <button
              type="button"
              className="entry"
              aria-current={position === cursor}
              tabIndex={-1}
              key={page.id}
              onClick={() => {
                onPick(page);
              }}
            >
              <span className="num">{page.label}</span>
              {page.title}
              <span className="where">{page.moduleTitle}</span>
            </button>
          );
        })}
        {results.length === 0 ? (
          <p className="empty">No page matches.</p>
        ) : null}
      </div>
    </Modal>
  );
};

export const Cheat = ({ onClose }: { onClose: () => void }) => {
  const groups = [
    ...new Set(
      keys.map((def) => {
        return def.group;
      }),
    ),
  ];

  return (
    <Modal title="Keys" onClose={onClose}>
      <p className="modal-hint">
        These keys work everywhere, inside the editor too.
      </p>
      <div className="cheat">
        {groups.map((group) => {
          return (
            <section key={group}>
              <h3>{group}</h3>
              <table>
                <tbody>
                  {keys
                    .filter((def) => {
                      return def.group === group;
                    })
                    .map((def) => {
                      return (
                        <tr key={def.id}>
                          <td>{def.label}</td>
                          <td>
                            {def.inField.map((spec) => {
                              return (
                                <kbd key={spec}>{hintOf(spec, isMac)}</kbd>
                              );
                            })}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </section>
          );
        })}
        <section>
          <h3>Editor</h3>
          <table>
            <tbody>
              {monacoOnly.map((item) => {
                return (
                  <tr key={item.label}>
                    <td>{item.label}</td>
                    <td>
                      <kbd>{item.combo}</kbd>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
      <p className="modal-hint">
        <kbd>Esc</kbd> closes this sheet.
      </p>
    </Modal>
  );
};
