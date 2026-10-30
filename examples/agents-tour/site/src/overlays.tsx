/**
 * @module
 * Overlays: the contents, the page search and the cheat sheet. Each takes
 * focus when it opens and gives it back when it closes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { hintOf, keys, monacoOnly } from "../../shared/keys.ts";
import type { PageSummary, TourIndex } from "../../shared/types.ts";
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

export const Contents = ({
  index,
  current,
  onPick,
  onClose,
}: {
  index: TourIndex;
  current: string;
  onPick: (page: PageSummary) => void;
  onClose: () => void;
}) => {
  const all = index.lessons.flatMap((lesson) => {
    return lesson.pages;
  });
  const [cursor, setCursor] = useState(
    Math.max(
      0,
      all.findIndex((page) => {
        return page.id === current;
      }),
    ),
  );
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>("[aria-current=true]")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <Modal title="Contents" onClose={onClose}>
      <div
        className="contents"
        ref={list}
        tabIndex={0}
        role="listbox"
        aria-label="Pages"
        onKeyDown={(event) => {
          if (event.key === "j" || event.key === "ArrowDown") {
            event.preventDefault();
            setCursor((value) => {
              return Math.min(all.length - 1, value + 1);
            });
          } else if (event.key === "k" || event.key === "ArrowUp") {
            event.preventDefault();
            setCursor((value) => {
              return Math.max(0, value - 1);
            });
          } else if (event.key === "Enter") {
            event.preventDefault();
            const page = all[cursor];

            if (page) {
              onPick(page);
            }
          }
        }}
      >
        {index.lessons.map((lesson) => {
          return (
            <section key={lesson.id}>
              <h3>{lesson.title}</h3>
              <p className="blurb">{lesson.blurb}</p>
              {lesson.pages.map((page) => {
                const selected = all[cursor]?.id === page.id;

                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-current={selected}
                    className="entry"
                    tabIndex={-1}
                    key={page.id}
                    onClick={() => {
                      onPick(page);
                    }}
                  >
                    <span className="num">{page.number}</span>
                    {page.title}
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
      <p className="modal-hint">
        <kbd>j</kbd> <kbd>k</kbd> move, <kbd>Enter</kbd> opens, <kbd>Esc</kbd>{" "}
        closes
      </p>
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

    return index.lessons
      .flatMap((lesson) => {
        return lesson.pages;
      })
      .filter((page) => {
        const text =
          `${page.number} ${page.title} ${page.lessonTitle}`.toLowerCase();

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
              <span className="num">{page.number}</span>
              {page.title}
              <span className="where">{page.lessonTitle}</span>
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
    "Code",
    "Pages",
    "Panes",
    "Slack",
    "GitHub",
    "Trace",
    "Focus",
  ] as const;

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
