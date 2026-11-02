/**
 * @module
 * What the nav and the chips show, worked out from the index and the
 * progress record. Plain functions, so they are tested without a browser.
 */
import type {
  Module,
  PageState,
  PageSummary,
  ProgressSnapshot,
  TourIndex,
} from "../../shared/types.ts";

type Pages = ProgressSnapshot["pages"];

// The furthest state a page reached.
export const stateOf = (pages: Pages, id: string): PageState | "none" => {
  const record = pages[id];

  if (record?.passed) {
    return "passed";
  }

  if (record?.ran) {
    return "ran";
  }

  return record?.opened ? "opened" : "none";
};

const core = (module: Module) => {
  return module.pages.filter((page) => {
    return page.kind === "core";
  });
};

// How far through its core path a module is, and whether its exercise passed.
export const moduleRow = (module: Module, pages: Pages) => {
  const own = core(module);

  return {
    core: own.length,
    reached: own.filter((page) => {
      return stateOf(pages, page.id) !== "none";
    }).length,
    done: own.some((page) => {
      return page.exercise && stateOf(pages, page.id) === "passed";
    }),
  };
};

// Go deeper pages not yet opened, in modules the reader has finished or left.
export const deeperWaiting = (index: TourIndex, pages: Pages) => {
  const left = index.modules.map((module, at) => {
    const later = index.modules.slice(at + 1).some((other) => {
      return other.pages.some((page) => {
        return stateOf(pages, page.id) !== "none";
      });
    });

    return later || moduleRow(module, pages).done;
  });

  return index.modules.flatMap((module, at) => {
    if (!left[at]) {
      return [];
    }

    return module.pages.filter((page) => {
      return page.kind === "deeper" && stateOf(pages, page.id) === "none";
    });
  });
};

// The buttons at the end of a module's core path, or null on any other page.
export const moduleEnd = (index: TourIndex, id: string) => {
  const at = index.modules.findIndex((module) => {
    return module.pages.some((page) => {
      return page.id === id;
    });
  });

  const module = index.modules[at];
  const last = module ? core(module).at(-1) : undefined;

  if (!module || last?.id !== id) {
    return null;
  }

  const next: PageSummary | undefined = index.modules[at + 1]?.pages[0];

  const deeper = module.pages.find((page) => {
    return page.kind === "deeper";
  });

  return { nextModule: next, deeper };
};
