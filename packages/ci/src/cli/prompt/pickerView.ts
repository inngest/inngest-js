/**
 * The picker as the lines of one frame, in the live view's style: a gutter
 * arrow on the highlighted row, a dim detail column and a hint at the foot.
 * Pure, so it's checked at a fixed width and height.
 *
 * @module
 */

import { type Paint, truncate } from "../render/format.ts";
import { combinations, describeCombo, type Target } from "../target.ts";
import { type PickerState, pickerRows, targetKey } from "./picker.ts";

const sectionOf = (target: Target): string => {
  if (target.kind === "pipeline") {
    return "Pipelines";
  }

  return target.axes ? "Matrices" : "Jobs";
};

/** A trigger as people say it: \`push\`, \`pull_request.opened\`, \`manual\`. */
const describeTrigger = (
  trigger: Extract<Target, { kind: "pipeline" }>["triggers"][number],
): string => {
  if (!("event" in trigger)) {
    return "cron";
  }

  return trigger.event
    .replace(/^github\//, "")
    .replace(/^ci\/manual\..*/, "manual");
};

const detailOf = (state: PickerState, target: Target): string => {
  if (target.kind === "pipeline") {
    return target.triggers.map(describeTrigger).join(" · ");
  }

  if (!target.axes) {
    return target.takesInput ? "takes input" : "";
  }

  const combos = combinations(target.axes);
  const index = state.combos[targetKey(target)];
  const open = state.expanded === targetKey(target);

  if (open) {
    return `${combos.length} combinations`;
  }

  const chosen =
    index === undefined
      ? `${combos.length} combinations`
      : describeCombo(combos[index] ?? {});

  return `${chosen} →`;
};

const hintOf = (state: PickerState): string => {
  const run =
    state.selected.length > 0
      ? `enter run ${state.selected.length} selected`
      : "enter run";

  return `↑↓ move · space select · → expand · ${run} · q quit`;
};

/**
 * The list under the header, then the hint. At most \`height\` lines: a long
 * list scrolls to keep the highlighted row in view.
 */
export const pickerLines = (
  state: PickerState,
  opts: { width: number; height: number; paint: Paint },
): string[] => {
  const { width, height, paint } = opts;
  const rows = pickerRows(state);
  const nameWidth = Math.min(
    Math.floor(width / 3),
    Math.max(
      ...state.targets.map((target) => {
        return target.id.length;
      }),
    ),
  );
  const list: string[] = [];
  let cursorLine = 0;
  let section: string | undefined;

  rows.forEach((row, index) => {
    const { target } = row;
    const label = sectionOf(target);
    const highlighted = index === state.cursor;
    const gutter = highlighted ? paint("bold", "› ") : "  ";

    if (label !== section) {
      list.push(...(section ? [""] : []), `  ${paint("dim", label)}`);
      section = label;
    }

    if (highlighted) {
      cursorLine = list.length;
    }

    if (row.kind === "combo") {
      const last =
        index === rows.length - 1 || rows[index + 1]?.kind !== "combo";
      const current = state.combos[targetKey(target)] === row.index;
      const combos = combinations(target.axes ?? {});
      const name = truncate(
        row.index === undefined
          ? "all"
          : describeCombo(combos[row.index] ?? {}),
        width - 8,
      );

      list.push(
        `${gutter}${paint("dim", last ? "└─ " : "├─ ")}${current ? paint("green", "●") : paint("dim", "○")} ${name}`,
      );

      return;
    }

    const selected = state.selected.includes(targetKey(target));
    const name = truncate(target.id, nameWidth);
    const detail = truncate(detailOf(state, target), width - nameWidth - 8);
    const marker = selected ? paint("green", "●") : paint("dim", "○");
    // Padding goes on only when a detail follows, so a line never ends in spaces.
    const cell = detail ? name.padEnd(nameWidth) : name;

    list.push(
      `${gutter}${marker} ${highlighted ? paint("bold", cell) : cell}${detail ? `  ${paint("dim", detail)}` : ""}`,
    );
  });

  const room = Math.max(1, height - 2);
  const start = Math.max(
    0,
    Math.min(cursorLine - Math.floor(room / 2), list.length - room),
  );

  return [
    ...list.slice(start, start + room),
    "",
    `  ${paint("dim", truncate(hintOf(state), width - 2))}`,
  ];
};
