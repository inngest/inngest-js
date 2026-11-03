/**
 * @module
 * The controls of an exercise page, under its text: a hint, Check and Show a
 * solution. Check says pass, or the one sentence the check gave for failing.
 */
import { useEffect, useState } from "react";
import type { CheckResult } from "../../shared/types.ts";
import { Kbd, shortcutsOf } from "./keyboard.tsx";
import { useAction } from "./live.ts";
import { Reveal } from "./motion.tsx";

type State = "idle" | "checking" | CheckResult;

export const Exercise = ({
  hint,
  check,
  showSolution,
  edits,
}: {
  hint?: string;
  check: () => Promise<CheckResult>;
  showSolution: () => Promise<void>;
  // Counts the reader's edits; a verdict is about the code as it was.
  edits: number;
}) => {
  const [showHint, setShowHint] = useState(false);
  const [state, setState] = useState<State>("idle");

  useEffect(() => {
    setState((current) => {
      return current === "checking" ? current : "idle";
    });
  }, [edits]);

  const runCheck = async () => {
    if (state === "checking") {
      return;
    }

    setState("checking");

    try {
      setState(await check());
    } catch (error) {
      setState({
        pass: false,
        reason: `The check could not run: ${String(error)}`,
      });
    }
  };

  useAction("check", () => {
    void runCheck();
  });

  useAction("hint", () => {
    setShowHint((value) => {
      return !value;
    });
  });

  useAction("solution", () => {
    void showSolution();
  });

  return (
    <div className="exercise">
      <div className="controls">
        <button
          type="button"
          className="primary"
          disabled={state === "checking"}
          onClick={runCheck}
          aria-keyshortcuts={shortcutsOf("check")}
        >
          Check <Kbd action="check" />
        </button>
        {hint ? (
          <button
            type="button"
            aria-pressed={showHint}
            onClick={() => {
              setShowHint(!showHint);
            }}
            aria-keyshortcuts={shortcutsOf("hint")}
          >
            Hint <Kbd action="hint" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void showSolution();
          }}
          aria-keyshortcuts={shortcutsOf("solution")}
        >
          Show a solution <Kbd action="solution" />
        </button>
      </div>
      <Reveal show={Boolean(showHint && hint)}>
        <p className="hint">{hint}</p>
      </Reveal>
      <p className="verdict" role="status" aria-live="polite">
        {state === "checking" ? "Checking..." : null}
        {typeof state === "object" && state.pass ? (
          <span className="pass">Passed.</span>
        ) : null}
        {typeof state === "object" && !state.pass ? (
          <span className="fail">{state.reason}</span>
        ) : null}
      </p>
    </div>
  );
};
