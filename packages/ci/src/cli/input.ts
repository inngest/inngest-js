/**
 * The data a run needs beyond its target, and where it comes from. For each
 * piece, a flag beats a saved fixture, which beats asking. Asking is a form
 * built from the data's schema, so a person is led through it field by field.
 *
 * @module
 */

import type { JsonSchema } from "../local/jsonSchema.ts";
import type { CliArgs } from "./args.ts";
import { describeFields, describeProblems } from "./prompt/formSchema.ts";
import type { Prompter } from "./prompter.ts";
import { SetupError } from "./setupError.ts";
import {
  type Combo,
  matchTrigger,
  selectCombos,
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
  /** The combinations of a matrix to run; absent is every one. */
  combos?: Combo[];
}

export interface ResolvedInput {
  input: RunInput;
  /** Whether anything was asked, which makes it worth saving as a fixture. */
  entered: boolean;
}

type PipelineTarget = Extract<Target, { kind: "pipeline" }>;
type JobTarget = Extract<Target, { kind: "job" }>;

const parseJson = (flag: string, value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new SetupError(`--${flag} is not valid JSON.`);
  }
};

/** What the command line says about `target`. */
export const flagInput = (
  args: Pick<CliArgs, "event" | "data" | "input" | "axes">,
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
    combos: selectCombos(target, args.axes),
  };
};

const checkComment = (text: string): string | undefined => {
  return text.trim() ? undefined : "Enter the comment.";
};

/** The JSON Schema of the data a manual trigger takes, if it could be had. */
const manualSchema = (
  target: PipelineTarget,
  trigger: string,
): JsonSchema | undefined => {
  for (const candidate of target.triggers) {
    if ("event" in candidate && candidate.event === trigger) {
      return candidate.schema;
    }
  }

  return undefined;
};

/**
 * Refuse data that surely doesn't match its schema, naming the fields it
 * wants, so a flag or a fixture fails here rather than in the run. Data that
 * isn't there only fails when the schema requires something.
 */
const checkAgainstSchema = (opts: {
  schema: JsonSchema | undefined;
  value: unknown;
  what: string;
  flag: string;
}): void => {
  const { schema, value, what, flag } = opts;

  if (!schema || (value === undefined && !schema.required?.length)) {
    return;
  }

  const problems = describeProblems(schema, value ?? {});

  if (problems.length === 0) {
    return;
  }

  const lines = problems.map((problem) => {
    return `  ${problem}`;
  });

  throw new SetupError(
    `${what} doesn't match its schema:\n${lines.join("\n")}`,
    {
      fix: `Fields: ${describeFields(schema)}\nPass them as JSON with ${flag}.`,
    },
  );
};

/** Ask for a manual or comment trigger's `event.data`. */
const askData = async (
  ask: Prompter,
  target: PipelineTarget,
  trigger: string,
  initial: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> => {
  if (trigger.startsWith("ci/manual.")) {
    const schema = manualSchema(target, trigger);
    const title = `${target.id} · event data`;
    const data = await ask.form(
      schema
        ? { title, schema, initial }
        : {
            title,
            schema: { type: "object" },
            note: `${target.id}'s data schema can't be shown as a form, so enter its data as JSON.`,
            initial,
          },
    );

    return (data ?? {}) as Record<string, unknown>;
  }

  if (trigger === "github/issue_comment.created") {
    const body = typeof initial?.body === "string" ? initial.body : undefined;

    return { body: await ask.line("Comment", checkComment, body) };
  }

  return undefined;
};

/** Ask for a job's input: a form from its `input` schema, or JSON without one. */
const askInput = (
  ask: Prompter,
  target: JobTarget,
  initial: unknown,
): Promise<unknown> => {
  const title = `${target.id} · input`;

  if (target.input) {
    return ask.form({ title, schema: target.input, initial });
  }

  return ask.form({
    title,
    schema: {},
    note: `${target.id} takes input but has no schema. Add \`input: <schema>\` to \`ci.job\` to get a form.`,
    initial,
  });
};

/** What was last entered as a job's input, from the saved inputs (oldest first). */
const lastInput = (saved: Record<string, RunInput>): unknown => {
  return Object.values(saved)
    .reverse()
    .find((fixture) => {
      return fixture.input !== undefined;
    })?.input;
};

/**
 * Work out what to run `target` with. `flags` are what the command line gave
 * and `fixture` is the saved input `--fixture` named; `saved` is every saved
 * input, oldest first, offered when nothing else was given. Questions are only
 * asked when there is a `ask`, and only for what is still missing.
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
  /** A saved input the form starts from, rather than uses as it is. */
  let seed: RunInput | undefined;

  if (!fixture && !given && ask && names.length > 0) {
    const chosen = await ask.choose(`Saved data for ${target.id}`, [
      ...names.flatMap((name) => {
        const input = opts.saved[name] as RunInput;

        return [
          { label: `Use ${name}`, value: { input, edit: false } },
          { label: `Start from ${name}`, value: { input, edit: true } },
        ];
      }),
      { label: "New", value: undefined },
    ]);

    fixture = chosen?.edit ? undefined : chosen?.input;
    seed = chosen?.edit ? chosen.input : undefined;
  }

  const base = fixture ?? seed;

  if (target.kind === "pipeline") {
    const events = triggerEvents(target.triggers);
    let trigger = flags.trigger ?? base?.trigger;

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
      data = await askData(ask, target, trigger, seed?.data);
      entered ||= data !== undefined;
    } else if (trigger.startsWith("ci/manual.")) {
      checkAgainstSchema({
        schema: manualSchema(target, trigger),
        value: data,
        what: `The data for ${target.id}`,
        flag: "--data",
      });
    }

    return { input: { trigger, data }, entered };
  }

  let input = flags.input ?? fixture?.input;

  if (input === undefined && target.takesInput && ask) {
    entered = true;
    input = await askInput(
      ask,
      target,
      seed?.input ?? (target.input ? undefined : lastInput(opts.saved)),
    );
  } else if (target.takesInput) {
    checkAgainstSchema({
      schema: target.input,
      value: input,
      what: `The input for ${target.id}`,
      flag: "--input",
    });
  }

  return { input: { input, combos: flags.combos ?? fixture?.combos }, entered };
};
