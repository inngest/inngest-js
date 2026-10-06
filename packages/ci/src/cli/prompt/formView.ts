/**
 * An input form as the lines of one frame, in the picker's style: a gutter
 * arrow on the highlighted option, dim guidance and a hint at the foot. Pure,
 * so it's checked at a fixed width and height.
 *
 * @module
 */

import { type Paint, truncate } from "../render/format.ts";
import { type FormState, formValue, reviewActions } from "./form.ts";
import { type Field, fieldKey, fieldName, typeLabel } from "./formSchema.ts";

interface Size {
  width: number;
  height: number;
  paint: Paint;
}

/** Break `text` into lines of at most `width` characters, at spaces. */
const wrap = (text: string, width: number): string[] => {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);

      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }

  return line ? [...lines, line] : lines;
};

/** An answer as it reads in a list: an option's label, a string as typed, else JSON. */
const showValue = (field: Field, value: unknown): string => {
  const option = field.options.find((candidate) => {
    return candidate.value === value;
  });

  if (option) {
    return option.label;
  }

  return typeof value === "string" ? value : JSON.stringify(value);
};

/** `room` of `lines` around `index`, so the highlighted one stays in view. */
const around = <T>(lines: T[], index: number, room: number): T[] => {
  const start = Math.max(
    0,
    Math.min(index - Math.floor(room / 2), lines.length - room),
  );

  return lines.slice(start, start + room);
};

const heading = (state: FormState, size: Size): string[] => {
  const { width, paint } = size;

  return [
    `  ${paint("bold", truncate(state.title, width - 2))}`,
    ...(state.note
      ? wrap(state.note, width - 2).map((line) => {
          return `  ${paint("yellow", line)}`;
        })
      : []),
    "",
  ];
};

/** Shows each option, with the highlighted one marked. */
const optionLines = (state: FormState, field: Field, size: Size): string[] => {
  const { width, paint } = size;
  const labels = [
    ...field.options.map((option) => {
      const fallback = option.value === field.schema.default;

      return `${option.label}${fallback ? paint("dim", "  default") : ""}`;
    }),
    ...(field.required ? [] : [paint("dim", "leave out")]),
  ];

  return labels.map((label, index) => {
    return index === state.cursor
      ? `${paint("bold", "› ")}${truncate(label, width - 4)}`
      : `  ${truncate(label, width - 4)}`;
  });
};

const hintOf = (field: Field): string => {
  if (field.kind === "choice") {
    return "↑↓ move · enter pick · esc cancel";
  }

  if (field.kind === "list") {
    return "enter adds an item · empty enter finishes · esc cancel";
  }

  return field.required
    ? "enter confirm · ctrl-u clears · esc cancel"
    : "enter confirm · empty enter leaves it out · esc cancel";
};

const askLines = (state: FormState, size: Size): string[] => {
  const { width, height, paint } = size;
  const field = state.fields[state.field] as Field;
  const total = state.fields.length;
  const meta = [
    total > 1 ? `${state.field + 1} of ${total}` : undefined,
    field.required ? "required" : "optional",
    // The options of a choice are listed below it.
    field.kind === "choice" ? undefined : typeLabel(field),
    field.schema.default === undefined
      ? undefined
      : `default ${showValue(field, field.schema.default)}`,
  ].filter(Boolean);
  const typed = `${paint("bold", "› ")}${truncate(state.text, width - 4)}${paint("dim", "▏")}`;

  const widget =
    field.kind === "choice"
      ? optionLines(state, field, size)
      : [
          ...(field.kind === "list"
            ? state.items.map((item) => {
                return `  ${paint("dim", "·")} ${truncate(String(item), width - 6)}`;
              })
            : []),
          typed,
        ];

  const current = [
    `  ${paint("bold", fieldName(field))}  ${paint("dim", truncate(meta.join(" · "), width - fieldName(field).length - 4))}`,
    ...wrap(field.schema.description ?? "", width - 2).map((line) => {
      return `  ${paint("dim", line)}`;
    }),
    ...widget,
    ...(state.error ? [`  ${paint("red", state.error)}`] : []),
  ];

  const earlier = state.editing ? [] : state.fields.slice(0, state.field);
  const nameWidth = Math.max(
    ...earlier.map((item) => {
      return fieldName(item).length;
    }),
    0,
  );
  const answered = earlier.map((item) => {
    const key = fieldKey(item);
    const name = fieldName(item).padEnd(nameWidth);

    if (!(key in state.answers)) {
      return `  ${paint("dim", `– ${name}  left out`)}`;
    }

    const value = truncate(
      showValue(item, state.answers[key]),
      width - nameWidth - 6,
    );

    return `  ${paint("green", "✓")} ${name}  ${value}`;
  });

  const top = heading(state, size);
  const foot = ["", `  ${paint("dim", truncate(hintOf(field), width - 2))}`];
  const room = height - top.length - current.length - foot.length - 1;

  return [
    ...top,
    ...(answered.length > 0
      ? [...answered.slice(Math.max(0, answered.length - room)), ""]
      : []),
    ...current,
    ...foot,
  ];
};

const actionLines = (state: FormState, size: Size): string[] => {
  return reviewActions.map((action, index) => {
    return index === state.cursor
      ? `${size.paint("bold", "› ")}${size.paint("bold", action)}`
      : `  ${action}`;
  });
};

const reviewLines = (state: FormState, size: Size): string[] => {
  const { height, paint } = size;
  const top = heading(state, size);
  const json = JSON.stringify(formValue(state), null, 2) ?? "(nothing)";
  const body = json.split("\n").map((line) => {
    return `  ${line}`;
  });
  const foot = [
    "",
    ...actionLines(state, size),
    "",
    `  ${paint("dim", "↑↓ move · enter pick · esc cancel")}`,
  ];
  const room = height - top.length - foot.length;
  const shown =
    body.length <= room
      ? body
      : [
          ...body.slice(0, Math.max(0, room - 1)),
          `  ${paint("dim", `… ${body.length - room + 1} more lines`)}`,
        ];

  return [...top, ...shown, ...foot];
};

const pickLines = (state: FormState, size: Size): string[] => {
  const { width, height, paint } = size;
  const nameWidth = Math.max(
    ...state.fields.map((field) => {
      return fieldName(field).length;
    }),
  );
  const rows = state.fields.map((field, index) => {
    const key = fieldKey(field);
    const value =
      key in state.answers
        ? truncate(showValue(field, state.answers[key]), width - nameWidth - 6)
        : paint("dim", "left out");
    const name = fieldName(field).padEnd(nameWidth);

    return index === state.cursor
      ? `${paint("bold", "› ")}${paint("bold", name)}  ${value}`
      : `  ${name}  ${value}`;
  });
  const top = [...heading(state, size), `  ${paint("bold", "Which field?")}`];
  const room = Math.max(1, height - top.length - 2);

  return [
    ...top,
    ...around(rows, state.cursor, room),
    "",
    `  ${paint("dim", "↑↓ move · enter edit · esc back")}`,
  ];
};

/**
 * The form under the header: the title, then what is being asked (the fields
 * answered so far, the field with its guidance and its prompt), the finished
 * value, or the fields to pick from. At most `height` lines.
 */
export const formLines = (state: FormState, size: Size): string[] => {
  switch (state.step) {
    case "ask": {
      return askLines(state, size);
    }

    case "review": {
      return reviewLines(state, size);
    }

    case "pick": {
      return pickLines(state, size);
    }
  }
};
