/**
 * @module
 * Progress: the state of every page (opened, ran, passed) and the concepts
 * collected so far, kept in the tour's cache folder so they outlive a browser
 * reset and the data folder that is wiped at start. The site marks pages as
 * the reader works; the check runner marks an exercise passed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PageState,
  ProgressMark,
  ProgressSnapshot,
} from "../../shared/types.ts";
import type { AreaFactory } from "../area.ts";
import { HttpError } from "../http-error.ts";

const states = new Set<string>(["opened", "ran", "passed"]);

export const area: AreaFactory = (ctx) => {
  const file = join(ctx.cacheDir, "progress.json");
  const pageOf = new Map(
    ctx.pages.map((page) => {
      return [page.id, page];
    }),
  );
  const allConcepts = new Set(
    ctx.pages.flatMap((page) => {
      return page.manifest.concepts ?? [];
    }),
  );
  let saved: Omit<ProgressSnapshot, "totalConcepts"> = {
    pages: {},
    concepts: {},
  };

  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // A damaged file starts the reader over rather than blocking the tour.
    }
  }

  const persist = () => {
    mkdirSync(ctx.cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify(saved));
  };
  const snapshot = (): ProgressSnapshot => {
    return { ...saved, totalConcepts: allConcepts.size };
  };

  return {
    name: "progress",
    routes: [
      {
        method: "GET",
        path: "/api/progress",
        handle: () => {
          return snapshot();
        },
      },
      {
        method: "POST",
        path: "/api/progress/mark",
        handle: ({ body }) => {
          const page = pageOf.get(String(body.page));
          const state = String(body.state);

          if (!page) {
            throw new HttpError(404, { error: "No such page" });
          }

          if (!states.has(state)) {
            throw new HttpError(400, { error: "No such page state" });
          }

          saved.pages[page.id] = {
            ...saved.pages[page.id],
            [state as PageState]: true,
          };

          const mark: ProgressMark = { collected: [], moduleDone: null };

          if (state === "opened") {
            for (const concept of page.manifest.concepts ?? []) {
              if (!saved.concepts[concept]) {
                saved.concepts[concept] = {
                  page: page.id,
                  definition: ctx.definitions[concept] ?? "",
                };
                mark.collected.push(concept);
              }
            }
          }

          if (state === "passed" && page.manifest.exercise) {
            mark.moduleDone = page.module;
          }

          persist();

          ctx.hub.broadcast({ type: "progress", mark, page: page.id });

          return mark;
        },
      },
      {
        method: "POST",
        path: "/api/progress/reset",
        handle: () => {
          saved = { pages: {}, concepts: {} };
          persist();
          ctx.hub.broadcast({
            type: "progress",
            mark: { collected: [], moduleDone: null },
            page: "",
          });

          return { ok: true };
        },
      },
    ],
  };
};
