/**
 * @module
 * The Trace panel: a waterfall of the real spans the Dev Server returns, one
 * row per span, a bar on a shared timeline, indentation from group spans.
 * By default a run shows only what the page has taught: the message that
 * started it, the calls the reader's code makes (steps, `inbox.next()`) and
 * Finalization, which every run has. What the SDK does on its own
 * (subscribe, inbox, close, thread records, KV reads) is plumbing, shown only
 * by "Show everything", which lists the raw tree.
 *
 * A row is never shown until the Trace is sure it belongs. The Dev Server
 * first answers a new run with placeholder spans (`Execution`, `Attempt 0`)
 * before the real ones exist; until those are replaced the run shows one
 * calm "running" row instead.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TourEvent, TraceRun, TraceStep } from "../../shared/types.ts";
import { api } from "./api.ts";
import { Fit, Reveal } from "./motion.tsx";

const housekeepingName =
  /^(kv\.|thread:|inbox:\d+:(open|close|stop)$|executor\.(?!nonstep)|metadata)/;

// The SDK's `thread:start` step is displayed as "Thread state", so the id,
// the name and the display name are all checked.
const housekeepingLabel = /^Thread state$/;

const isHousekeeping = (step: TraceStep) => {
  return (
    housekeepingName.test(step.name) ||
    housekeepingName.test(step.id) ||
    housekeepingLabel.test(step.name)
  );
};

const isFinalization = (step: TraceStep) => {
  return step.name === "executor.nonstep";
};

// The group span an `inbox.next()` call leaves (its child, `inbox:start`, is
// plumbing). The reader's own call, so it is the one inbox span shown by default.
const isNextCall = (step: TraceStep) => {
  return step.id === 'span:["inbox:start"]';
};

// What the SDK does on its own. Only "Show everything" lists it. Spans are
// decided by what the run recorded: an agent whose body never calls
// `inbox.next()` has no `next` span, so nothing here guesses from the code.
const isPlumbing = (step: TraceStep) => {
  if (isNextCall(step)) {
    return false;
  }

  return (
    isHousekeeping(step) ||
    /^span:\["inbox/.test(step.id) ||
    /^(inbox|subscribe|close)\b/.test(step.name)
  );
};

// The Dev Server lists these top-level spans for a run that has just been
// queued or started, before its real spans exist. They say nothing about the
// run, so they are never rows; while one is there the Trace is not sure what
// the run will show.
const isPlaceholder = (step: TraceStep) => {
  return /^(Execution|Attempt \d+)$/.test(step.name);
};

// The run waits for a message only where the code called `inbox.next()`.
const callsNext = (steps: TraceStep[]): boolean => {
  return steps.some((step) => {
    return isNextCall(step) || callsNext(step.children);
  });
};

// A gap this long between two steps of a run is the run parked, waiting for
// a message: the executor stores no span for a park, so the gap is the
// `inbox.next()` row, whatever (even housekeeping) step ends it.
const waitGapMs = 600;

// `shown` is whether the row is on screen in the current mode. Every row is
// built either way, so a row that "Show everything" adds or removes keeps its
// key and can animate in or out instead of being swapped.
type Row =
  | {
      kind: "step";
      key: string;
      step: TraceStep;
      depth: number;
      shown: boolean;
    }
  | {
      kind: "wait";
      key: string;
      from: number;
      to: number;
      live: boolean;
      depth: number;
      shown: boolean;
    };

const time = (iso: string | null) => {
  return iso ? new Date(iso).getTime() : null;
};

const endOf = (step: TraceStep, now: number): number | null => {
  const start = time(step.startedAt);

  if (start === null) {
    return null;
  }

  return time(step.endedAt) ?? (step.status === "RUNNING" ? now : start);
};

type IconKind = "inbox" | "event" | "step" | "kv" | "wait" | "agent" | "code";

const kindOf = (step: TraceStep): IconKind => {
  if (/^inbox/.test(step.name)) {
    return "inbox";
  }

  if (/^kv\./.test(step.name)) {
    return "kv";
  }

  if (/sleep|wait/i.test(step.name) || step.type === "step.sleep") {
    return "wait";
  }

  if (isFinalization(step)) {
    return "code";
  }

  if (step.group || step.children.length > 0) {
    return "agent";
  }

  return "step";
};

const paths: Record<IconKind, string> = {
  inbox: "M2 4h12v8H2zM2 4l6 5 6-5",
  event: "M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z",
  step: "M4 3l8 5-8 5z",
  kv: "M10.5 2a3.5 3.5 0 1 0 .6 6.9L14 12v2h-2v-1.5H10.5V11H9L7.2 9.2A3.5 3.5 0 0 0 10.5 2z",
  wait: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 5v3.5L10.5 10",
  agent: "M2 4h12M2 8h9M2 12h6",
  code: "M6 4 2 8l4 4M10 4l4 4-4 4",
};

const Icon = ({ kind }: { kind: IconKind }) => {
  return (
    <svg
      className="wf-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
};

const label = (step: TraceStep, everything: boolean) => {
  if (isFinalization(step)) {
    return "Finalization";
  }

  if (!everything && isNextCall(step)) {
    return "inbox.next()";
  }

  return step.name;
};

// The run ends where its Finalization span ends, or at the run's own finish
// time when no such span was recorded. Null while the run is still going.
const finishOf = (run: TraceRun): number | null => {
  let finalEnd: number | null = null;

  for (const step of run.steps) {
    const end = isFinalization(step) ? time(step.endedAt) : null;

    if (end !== null && (finalEnd === null || end > finalEnd)) {
      finalEnd = end;
    }
  }

  return finalEnd ?? time(run.endedAt);
};

const rounded = (ms: number) => {
  if (ms < 100) {
    return "<100 ms";
  }

  if (ms < 1000) {
    return `${Math.round(ms / 100) * 100} ms`;
  }

  return `${(ms / 1000).toFixed(1)} s`;
};

const rowsOf = (
  steps: TraceStep[],
  everything: boolean,
  now: number,
  live: boolean,
  depth = 0,
  prefix = "",
  parentShown = true,
) => {
  const rows: Row[] = [];
  let lastEnd: number | null = null;
  let lastID = "";
  // A park is an `inbox.next()` row only when the code called it.
  const waitShown = everything || callsNext(steps);

  for (const step of steps) {
    const start = time(step.startedAt);

    if (
      depth === 0 &&
      lastEnd !== null &&
      start !== null &&
      start - lastEnd > waitGapMs
    ) {
      // Keyed by the step before the gap, so the live row and the row it
      // becomes once the run goes on are one node.
      rows.push({
        kind: "wait",
        key: `${prefix}w:after:${lastID}`,
        from: lastEnd,
        to: start,
        live: false,
        depth,
        shown: waitShown,
      });
    }

    const shown =
      parentShown &&
      !(depth === 0 && isPlaceholder(step)) &&
      (everything || !isPlumbing(step));

    rows.push({ kind: "step", key: `${prefix}${step.id}`, step, depth, shown });
    rows.push(
      ...rowsOf(
        step.children,
        everything,
        now,
        live,
        depth + 1,
        `${prefix}${step.id}/`,
        shown,
      ),
    );

    const end = endOf(step, now);

    if (end !== null && (lastEnd === null || end > lastEnd)) {
      lastEnd = end;
      lastID = step.id;
    }
  }

  if (depth === 0 && lastEnd !== null && now - lastEnd > waitGapMs) {
    rows.push({
      kind: "wait",
      key: `${prefix}w:after:${lastID}`,
      from: lastEnd,
      to: now,
      live,
      depth,
      shown: waitShown,
    });
  }

  return depth === 0 ? uniqueKeys(rows) : rows;
};

// Two calls can leave spans with the same id (two `inbox.next()` in one run);
// a repeated key would remount or merge rows, so later ones get a counter.
const uniqueKeys = (rows: Row[]): Row[] => {
  const seen = new Map<string, number>();

  return rows.map((row) => {
    const count = seen.get(row.key) ?? 0;

    seen.set(row.key, count + 1);

    return count === 0 ? row : { ...row, key: `${row.key}#${count}` };
  });
};

// Text that is JSON is parsed, even when it is JSON inside a string.
const parse = (text: string | null): unknown => {
  if (text === null) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(text);

    return typeof value === "string" ? parse(value) : value;
  } catch {
    return text;
  }
};

const token =
  /("(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/**
 * Pretty JSON with the keys, strings, numbers and booleans in colour.
 */
export const Json = ({ value }: { value: unknown }) => {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  let offset = 0;

  return (
    <pre className="step-detail">
      {text.split(token).map((part) => {
        const at = offset;

        offset += part.length;

        if (typeof value === "string") {
          return part;
        }

        let kind = "";

        if (part.startsWith('"')) {
          kind = part.endsWith(":") ? "jv-key" : "jv-string";
        } else if (/^(true|false|null)$/.test(part)) {
          kind = "jv-bool";
        } else if (/^-?\d/.test(part)) {
          kind = "jv-number";
        }

        return kind ? (
          <span className={kind} key={at}>
            {part}
          </span>
        ) : (
          part
        );
      })}
    </pre>
  );
};

const Detail = ({ outputID }: { outputID: string | null }) => {
  const [out, setOut] = useState<
    | { error: { name: string | null; message: string; stack?: string } }
    | { value: unknown }
    | undefined
  >();

  useEffect(() => {
    if (!outputID) {
      setOut({ value: undefined });

      return;
    }

    void api
      .output(outputID)
      .then((result) => {
        setOut(
          result.error
            ? { error: result.error }
            : { value: parse(result.data) },
        );
      })
      .catch(() => {
        setOut({ value: undefined });
      });
  }, [outputID]);

  // One Fit around every state, so Loading... growing into the JSON is a
  // height change, and the content fades in as it is swapped.
  let body: React.ReactNode;

  if (!out) {
    body = (
      <pre className="step-detail" key="loading">
        Loading...
      </pre>
    );
  } else if ("error" in out) {
    const stack = (out.error.stack ?? "").split("\n").slice(1, 4).join("\n");

    body = (
      <pre className="step-detail error-detail" key="error">
        {out.error.name ?? "Error"}: {out.error.message}
        {stack ? `\n${stack}` : ""}
      </pre>
    );
  } else if (out.value === undefined) {
    body = (
      <pre className="step-detail" key="none">
        No value
      </pre>
    );
  } else {
    body = <Json value={out.value} key="value" />;
  }

  return (
    <Fit>
      <div className="fade-in" key={out ? "loaded" : "loading"}>
        {body}
      </div>
    </Fit>
  );
};

const Result = ({ run }: { run: TraceRun }) => {
  const [text, setText] = useState<{ error: boolean; value: string }>();

  useEffect(() => {
    if (!run.output) {
      setText(undefined);

      return;
    }

    void api
      .output(run.output)
      .then((out) => {
        setText(
          out.error
            ? { error: true, value: out.error.message }
            : { error: false, value: out.data ?? "" },
        );
      })
      .catch(() => {
        setText(undefined);
      });
  }, [run.output]);

  if (!text || text.value === "" || text.value === "null") {
    return null;
  }

  return (
    <code
      className={text.error ? "run-output error fade-in" : "run-output fade-in"}
    >
      {text.error ? "failed: " : "returned "}
      {text.value}
    </code>
  );
};

const Trigger = ({ run }: { run: TraceRun }) => {
  const [open, setOpen] = useState(false);

  if (!run.trigger) {
    return null;
  }

  const message = run.trigger.name === "agent/message";
  const content = run.trigger.data.content;

  return (
    <div>
      <button
        type="button"
        className="wf-row trigger-row"
        data-row
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="wf-name">
          <Icon kind={message ? "inbox" : "event"} />
          {message ? "message" : run.trigger.name}
          {typeof content === "string" ? <em>{content}</em> : null}
        </span>
        <span className="wf-track">
          <i className="wf-bar completed" style={{ left: 0 }} />
        </span>
        <span className="wf-time" />
      </button>
      <Reveal show={open} appear>
        <Json value={run.trigger} />
      </Reveal>
    </div>
  );
};

// The calm stand-in for rows the Trace is not sure of yet.
const PendingRow = () => {
  return (
    <div className="wf-row pending-row" aria-label="Running">
      <span className="wf-name">
        <span className="dot running" aria-hidden="true" />
        running
      </span>
      <span className="wf-track">
        <i className="wf-bar pending" />
      </span>
      <span className="wf-time" />
    </div>
  );
};

export interface RunPressed {
  // When Run was pressed.
  at: number;
  // What Run runs, when the page has a `run.ts`; null when it is not known.
  label: string | null;
}

// How long a placeholder waits for a real run before it gives up.
const pendingMs = 15_000;

// The card for a run Run has started but the Dev Server has not listed yet.
// It names only what is known: the file Run runs, never the agent.
const PendingRun = ({ label }: { label: string | null }) => {
  return (
    <section className="run" aria-label="Starting a run">
      <div className="run-head">
        <span className="dot running" aria-hidden="true" />
        <strong>Running{label ? <code>{label}</code> : null}...</strong>
      </div>
      <div className="wf" role="list">
        <div role="listitem">
          <PendingRow />
        </div>
      </div>
    </section>
  );
};

const Run = ({
  run,
  everything,
  now,
}: {
  run: TraceRun;
  everything: boolean;
  now: number;
}) => {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showResult, setShowResult] = useState(false);
  const live = !["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(
    run.status,
  );
  const toggle = (key: string) => {
    setOpen((previous) => {
      const next = new Set(previous);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  };
  // The run's end is the end of its Finalization span: it grows with the
  // clock while the run goes and locks once Finalization has ended.
  const finish = finishOf(run);
  const clock = finish ?? now;
  const rows = useMemo(() => {
    return rowsOf(run.steps, everything, clock, live && finish === null);
  }, [run.steps, everything, clock, live, finish]);
  // Not sure yet what the run shows: placeholder spans are all there is, or
  // nothing shows and the run is still going. One running row stands in.
  const unsure = run.steps.some(isPlaceholder);
  const pending =
    live &&
    (unsure ||
      !rows.some((row) => {
        return row.shown;
      }));
  // Rows present when the run first renders are not animated; ones that
  // arrive later (or that Show everything adds) fade and grow in.
  const initialRows = useRef<boolean>(true);

  useEffect(() => {
    initialRows.current = false;
  }, []);

  const starts = [time(run.queuedAt), time(run.startedAt)].filter(
    (value): value is number => {
      return value !== null;
    },
  );
  const firstStart = (steps: TraceStep[]): number[] => {
    return steps.flatMap((step) => {
      const start = time(step.startedAt);

      return [...(start === null ? [] : [start]), ...firstStart(step.children)];
    });
  };
  const t0 = Math.min(...starts, ...firstStart(run.steps), clock);
  const t1 = Math.max(clock, t0 + 1);
  const span = t1 - t0;
  const bar = (from: number, to: number) => {
    const left = Math.min(Math.max(from, t0), t1);
    const right = Math.min(Math.max(to, left), t1);

    return {
      left: `min(${((left - t0) / span) * 100}%, calc(100% - 12px))`,
      width: `${Math.max(0.8, ((right - left) / span) * 100)}%`,
    };
  };

  return (
    <section className="run" aria-label={`Run of ${run.fn}`}>
      <button
        type="button"
        className="run-head"
        data-row
        aria-expanded={showResult}
        onClick={() => setShowResult(!showResult)}
      >
        <span
          className={`dot ${run.status.toLowerCase()}`}
          aria-hidden="true"
        />
        <strong>{run.fn}</strong>
        <span className="status fade-in" key={run.status}>
          {run.status.toLowerCase()}
        </span>
        {showResult ? null : <Result run={run} />}
        <span className="run-total">{rounded(t1 - t0)}</span>
      </button>
      <Reveal show={showResult}>
        <Detail outputID={run.output} />
      </Reveal>
      <div className="wf" role="list">
        <Trigger run={run} />
        {rows.map((row) => {
          const pad = { paddingLeft: 20 + row.depth * 16 };

          if (row.kind === "wait") {
            return (
              <Reveal
                role="listitem"
                key={row.key}
                show={row.shown}
                appear={!initialRows.current}
              >
                <div
                  className={`wf-row wait-row ${row.live ? "live" : ""}`}
                  title="The bar is the time the run spent waiting for a message"
                  data-row
                  tabIndex={-1}
                  style={pad}
                >
                  <span className="wf-name">
                    <Icon kind="inbox" />
                    inbox.next()
                  </span>
                  <span className="wf-track">
                    <i
                      className={`wf-bar ${row.live ? "waiting" : "completed"}`}
                      style={bar(row.from, row.to)}
                    />
                  </span>
                  <span className="wf-time">{rounded(row.to - row.from)}</span>
                </div>
              </Reveal>
            );
          }

          const { step } = row;
          const start = time(step.startedAt);
          const end = endOf(step, clock);
          const expanded = open.has(row.key);
          const attempts = step.attempts && step.attempts > 1;

          return (
            <Reveal
              role="listitem"
              key={row.key}
              show={row.shown}
              appear={!initialRows.current}
            >
              <button
                type="button"
                className={`wf-row ${step.children.length > 0 ? "group" : ""}`}
                data-row
                style={pad}
                aria-expanded={expanded}
                onClick={() => toggle(row.key)}
              >
                <span className="wf-name">
                  <Icon kind={kindOf(step)} />
                  {label(step, everything)}
                  {attempts ? (
                    <em className="tries"> attempt {step.attempts}</em>
                  ) : null}
                </span>
                <span className="wf-track">
                  {start !== null && end !== null ? (
                    <i
                      className={`wf-bar ${step.status.toLowerCase()}`}
                      style={bar(start, end)}
                    />
                  ) : null}
                </span>
                <span className="wf-time">
                  {start !== null && end !== null ? rounded(end - start) : ""}
                </span>
              </button>
              <Reveal show={expanded}>
                <Detail outputID={step.outputID} />
              </Reveal>
            </Reveal>
          );
        })}
        <Reveal role="listitem" show={pending} appear={!initialRows.current}>
          <PendingRow />
        </Reveal>
      </div>
    </section>
  );
};

type Line = Extract<TourEvent, { type: "log" }>;

const Console = ({ lines }: { lines: Line[] }) => {
  const [open, setOpen] = useState(false);

  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="run console">
      <button
        type="button"
        className="wf-row hidden-row"
        data-row
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="wf-name">
          console, {lines.length} {lines.length === 1 ? "line" : "lines"}
        </span>
      </button>
      <Reveal show={open}>
        <pre className="step-detail">
          {lines
            .map((line) => {
              return line.text;
            })
            .join("\n")}
        </pre>
      </Reveal>
    </div>
  );
};

export const TracePanel = ({
  runs,
  lines,
  everything,
  onToggle,
  pressed,
}: {
  runs: TraceRun[];
  lines: Line[];
  everything: boolean;
  onToggle: () => void;
  pressed: RunPressed | null;
}) => {
  const [now, setNow] = useState(Date.now());
  // Runs already listed when the panel first renders do not animate in.
  const firstRuns = useRef(new Set(runs.map((run) => run.id)));
  // The placeholder run card: from Run being pressed until a run that was not
  // listed then appears, an error is logged, or the wait runs out.
  const [waiting, setWaiting] = useState<{
    label: string | null;
    before: Set<string>;
    errors: number;
  } | null>(null);
  const latest = useRef({ runs, errors: 0 });
  const errors = lines.filter((line) => {
    return line.kind === "err";
  }).length;

  latest.current = { runs, errors };

  useEffect(() => {
    if (!pressed) {
      setWaiting(null);

      return;
    }

    setWaiting({
      label: pressed.label,
      before: new Set(
        latest.current.runs.map((run) => {
          return run.id;
        }),
      ),
      errors: latest.current.errors,
    });

    const timer = window.setTimeout(() => {
      setWaiting(null);
    }, pendingMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [pressed]);

  const arrived = waiting
    ? runs.some((run) => {
        return !waiting.before.has(run.id);
      })
    : false;
  const failed = waiting ? errors > waiting.errors : false;
  const placeholder = waiting !== null && !arrived && !failed;
  // Runs listed when Run was pressed fade out at once and stay out, so old
  // and new cards are never side by side and the server clearing them later
  // changes nothing on screen.
  const superseded = (run: TraceRun) => {
    return waiting !== null && !failed && waiting.before.has(run.id);
  };
  const live = runs.some((run) => {
    return !["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(
      run.status,
    );
  });

  useEffect(() => {
    if (!live) {
      setNow(Date.now());

      return;
    }

    // Frames keep a running duration and the bars moving smoothly; people who
    // ask for less motion get four updates a second.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const timer = window.setInterval(() => {
        setNow(Date.now());
      }, 250);

      return () => {
        window.clearInterval(timer);
      };
    }

    let frame = 0;
    const tick = () => {
      setNow(Date.now());
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [live]);

  return (
    <div className="trace" aria-label="Trace" tabIndex={-1}>
      <div className="trace-bar">
        <span>
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
        <button
          type="button"
          className="ghost"
          tabIndex={-1}
          onClick={onToggle}
          aria-pressed={everything}
        >
          Show everything
        </button>
      </div>
      {lines
        .filter((line) => {
          return line.kind === "err";
        })
        .map((line, at) => {
          return (
            <p className="notice" key={`${at}-${line.text}`}>
              {line.text}
            </p>
          );
        })}
      <Reveal show={runs.length === 0 && !placeholder} appear={false}>
        <p className="empty">
          Waiting for a run. Press Run, or send a message.
        </p>
      </Reveal>
      <Reveal className="run-slot" show={placeholder}>
        <PendingRun label={waiting?.label ?? null} />
      </Reveal>
      {[...runs].reverse().map((run) => {
        return (
          <Reveal
            className="run-slot"
            key={run.id}
            show={!superseded(run)}
            appear={!firstRuns.current.has(run.id)}
          >
            <Run run={run} everything={everything} now={now} />
          </Reveal>
        );
      })}
      <Console
        lines={lines.filter((line) => {
          return line.kind === "out";
        })}
      />
    </div>
  );
};
