/**
 * The data a run needs beyond its target, and where it comes from. For each
 * piece, a flag beats a saved fixture, which beats asking.
 *
 * @module
 */

import type { CliArgs } from "./args.ts";
import type { Prompter } from "./prompter.ts";
import { SetupError } from "./setupError.ts";
import {
  type Combo,
  combinations,
  describeCombo,
  matchTrigger,
  parseCombo,
  type Target,
  triggerEvents,
} from "./target.ts";

/** What a run needs that git can't supply. Saved as a fixture, so it's plain JSON. */
export interface RunInput {
  /** A pipeline's trigger event, when it has several. */
  trigger?: string;
  /** The `event.data` of a manual or comment trigger. */
  data?: Record<string, unknown>;
  /** A job's input. */
  input?: unknown;
  /** A matrix's combination; `{}` is every one. */
  combo?: Combo;
}

export interface ResolvedInput {
  input: RunInput;
  /** Whether anything was asked, which makes it worth saving as a fixture. */
  entered: boolean;
}

const parseJson = (flag: string, value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new SetupError(`--${flag} is not valid JSON.`);
  }
};

/** What the command line says about `target`. */
export const flagInput = (
  args: Pick<CliArgs, "event" | "data" | "input" | "combo">,
  target: Target,
): RunInput => {
  if (target.kind === "pipeline") {
    return {
      trigger:
        args.event && matchTrigger(triggerEvents(target.triggers), args.event),
      data: args.data
        ? (parseJson("data", args.data) as Record<string, unknown>)
        : undefined,
    };
  }

  return {
    input: args.input ? parseJson("input", args.input) : undefined,
    combo: parseCombo(target.axes, args.combo),
  };
};

/** What is wrong with `text` as JSON, if anything. */
const checkJson = (text: string): string | undefined => {
  try {
    JSON.parse(text);

    return undefined;
  } catch {
    return "Not valid JSON.";
  }
};

const checkJsonObject = (text: string): string | undefined => {
  if (text === "") {
    return undefined;
  }

  return (
    checkJson(text) ?? (/^\s*\{/.test(text) ? undefined : "Not an object.")
  );
};

const checkComment = (text: string): string | undefined => {
  return text.trim() ? undefined : "Enter the comment.";
};

/** Ask for a manual or comment trigger's `event.data`. */
const askData = async (
  ask: Prompter,
  trigger: string,
): Promise<Record<string, unknown> | undefined> => {
  if (trigger.startsWith("ci/manual.")) {
    const text = await ask.line(
      "Event data, as JSON (empty for none)",
      checkJsonObject,
    );

    return text ? JSON.parse(text) : {};
  }

  if (trigger === "github/issue_comment.created") {
    return { body: await ask.line("Comment", checkComment) };
  }

  return undefined;
};

/**
 * Work out what to run `target` with. `flags` are what the command line gave
 * and `fixture` is the saved input `--fixture` named; `saved` is every saved
 * input, offered when nothing else was given. Questions are only asked when
 * there is a `ask`, and only for what is still missing.
 */
export const resolveInput = async (opts: {
  target: Target;
  flags: RunInput;
  fixture?: RunInput;
  saved: Record<string, RunInput>;
  ask?: Prompter;
}): Promise<ResolvedInput> => {
  const { target, flags, ask } = opts;
  const given = Object.values(flags).some((value) => {
    return value !== undefined;
  });
  const names = Object.keys(opts.saved);
  let entered = false;
  let fixture = opts.fixture;

  if (!fixture && !given && ask && names.length > 0) {
    fixture = await ask.choose("Use saved data?", [
      ...names.map((name) => {
        return { label: `use fixture: ${name}`, value: opts.saved[name] };
      }),
      { label: "enter new", value: undefined },
    ]);
  }

  if (target.kind === "pipeline") {
    const events = triggerEvents(target.triggers);
    let trigger = flags.trigger ?? fixture?.trigger;

    if (!trigger && events.length === 1) {
      trigger = events[0];
    }

    if (!trigger && ask) {
      entered = true;
      trigger = await ask.choose(
        "Which trigger?",
        events.map((event) => {
          return { label: event, value: event };
        }),
      );
    }

    if (!trigger) {
      throw new SetupError("This pipeline has several triggers.", {
        fix: `Pick one with --event: ${events.join(", ")}`,
      });
    }

    let data = flags.data ?? fixture?.data;

    if (!data && ask) {
      data = await askData(ask, trigger);
      entered ||= data !== undefined;
    }

    return { input: { trigger, data }, entered };
  }

  let input = flags.input ?? fixture?.input;

  if (input === undefined && target.takesInput && ask) {
    entered = true;
    input = JSON.parse(await ask.line("Input, as JSON", checkJson));
  }

  let combo = flags.combo ?? fixture?.combo;

  if (!combo && target.axes && ask) {
    entered = true;
    combo = await ask.choose("Which combination?", [
      { label: "all", value: {} },
      ...combinations(target.axes).map((value) => {
        return { label: describeCombo(value), value };
      }),
    ]);
  }

  return { input: { input, combo }, entered };
};
