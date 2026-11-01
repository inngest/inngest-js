/**
 * Shaping what the parsers found into the annotations a check carries: repeats
 * grouped, duplicates dropped, failures first, and no more than the cap.
 *
 * @module
 */

import type { CheckAnnotation } from "../types.ts";
import type { Found } from "./found.ts";

/**
 * How many annotations one check carries. GitHub documents no total limit; this
 * keeps the Checks tab readable, and is four requests of 50.
 */
export const maxAnnotations = 200;

/** A rule or message on more lines than this becomes one annotation. */
export const groupAfter = 5;

const rank = { failure: 0, warning: 1, notice: 2 } as const;

/** The same problem found twice, as when two reports cover one file. */
const withoutDuplicates = (found: Found[]): Found[] => {
  const seen = new Set<string>();

  return found.filter((item) => {
    const key = `${item.file}:${item.line}:${item.message}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
};

/**
 * One annotation for a rule or message that repeats past `groupAfter` lines: on
 * the first line, naming how many more there are, with their places in the
 * details.
 */
const grouped = (found: Found[]): Found[] => {
  const groups = new Map<string, Found[]>();

  for (const item of found) {
    // Without a rule, only the same message of the same title repeats.
    const key = `${item.tool}:${item.level}:${item.rule ?? `${item.title}:${item.message}`}`;

    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.values()].flatMap((group) => {
    const [first, ...rest] = group;

    if (!first || group.length <= groupAfter) {
      return group;
    }

    return [
      {
        ...first,
        title: `${rest.length} more of ${first.rule ?? first.title}`,
        details: rest
          .slice(0, 50)
          .map((item) => {
            return `${item.file}:${item.line}`;
          })
          .join("\n"),
      },
    ];
  });
};

const annotationOf = (item: Found): CheckAnnotation => {
  return {
    path: item.file,
    start_line: item.line,
    end_line: item.endLine ?? item.line,
    annotation_level: item.level,
    title: item.title,
    message: item.message || item.title,
    ...(item.details ? { raw_details: item.details } : {}),
  };
};

export interface Shaped {
  annotations: CheckAnnotation[];
  /** How many were left out for the cap. */
  omitted: number;
  /** What the omitted ones were, by tool. */
  omittedByTool: Record<string, number>;
}

/**
 * What a check carries: the job's own annotations, then what the tools found.
 * Failures come first, then warnings, then notices; within a level, the job's
 * own come before the tools'.
 */
export const shapeAnnotations = (
  own: CheckAnnotation[],
  found: Found[],
  cap = maxAnnotations,
): Shaped => {
  const tooled = grouped(withoutDuplicates(found));

  const all = [
    ...own.map((annotation) => {
      return {
        annotation,
        tool: "the job",
        level: annotation.annotation_level ?? "failure",
      };
    }),
    ...tooled.map((item) => {
      return {
        annotation: annotationOf(item),
        tool: item.tool as string,
        level: item.level,
      };
    }),
  ].sort((a, b) => {
    return rank[a.level] - rank[b.level];
  });

  const omitted = all.slice(cap);
  const omittedByTool: Record<string, number> = {};

  for (const item of omitted) {
    omittedByTool[item.tool] = (omittedByTool[item.tool] ?? 0) + 1;
  }

  return {
    annotations: all.slice(0, cap).map((item) => {
      return item.annotation;
    }),
    omitted: omitted.length,
    omittedByTool,
  };
};

/** The sentence a check's summary adds when annotations were left out. */
export const omittedNote = (shaped: Shaped): string | undefined => {
  if (shaped.omitted === 0) {
    return undefined;
  }

  const by = Object.entries(shaped.omittedByTool)
    .map(([tool, count]) => {
      return `${count} from ${tool}`;
    })
    .join(", ");

  return `… and ${shaped.omitted} more annotations (${by}), see the trace.`;
};
