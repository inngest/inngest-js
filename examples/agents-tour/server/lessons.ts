/**
 * @module
 * Reads the lessons from disk: `lessons/<nn-lesson>/<nn-page>/` with
 * `page.md`, an optional `agent.ts` and `setup.ts`, and `manifest.json`.
 * Pages are numbered in order across lessons by the number in the page's
 * directory name.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Lesson, Manifest, Page, PageFile, TourIndex } from "../shared/types.ts";

const dirs = (path: string) => {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => {
      return entry.isDirectory() && !entry.name.startsWith("_");
    })
    .map((entry) => {
      return entry.name;
    })
    .sort();
};

const titleOf = (markdown: string) => {
  const first = markdown.split("\n")[0] ?? "";

  return first.replace(/^#\s*/, "").trim();
};

const withoutTitle = (markdown: string) => {
  return markdown.split("\n").slice(1).join("\n").trim();
};

const idOf = (lessonDir: string, pageDir: string) => {
  return `${lessonDir.replace(/^\d+-/, "")}/${pageDir.replace(/^\d+-/, "")}`;
};

export interface LoadedPage extends Page {
  dir: string;
}

export const loadLessons = (lessonsDir: string) => {
  const pages: LoadedPage[] = [];
  const lessons: Lesson[] = [];

  for (const lessonDir of dirs(lessonsDir)) {
    const lessonPath = join(lessonsDir, lessonDir);
    const meta = JSON.parse(
      readFileSync(join(lessonPath, "lesson.json"), "utf8"),
    ) as { title: string; blurb: string };
    const lesson: Lesson = {
      id: lessonDir.replace(/^\d+-/, ""),
      title: meta.title,
      blurb: meta.blurb,
      pages: [],
    };

    for (const pageDir of dirs(lessonPath)) {
      const dir = join(lessonPath, pageDir);
      const markdown = readFileSync(join(dir, "page.md"), "utf8");
      const manifest = JSON.parse(
        readFileSync(join(dir, "manifest.json"), "utf8"),
      ) as Manifest;
      const files: PageFile[] = [];

      if (manifest.code !== false) {
        files.push({
          name: "agent.ts",
          content: readFileSync(join(dir, "agent.ts"), "utf8"),
          editable: true,
        });

        if (existsSync(join(dir, "setup.ts"))) {
          files.push({
            name: "setup.ts",
            content: readFileSync(join(dir, "setup.ts"), "utf8"),
            editable: false,
          });
        }
      }

      const page: LoadedPage = {
        id: idOf(lessonDir, pageDir),
        number: Number.parseInt(pageDir, 10),
        lesson: lesson.id,
        lessonTitle: lesson.title,
        title: titleOf(markdown),
        markdown: withoutTitle(markdown),
        files,
        manifest,
        dir,
      };

      pages.push(page);
      lesson.pages.push({
        id: page.id,
        number: page.number,
        lesson: page.lesson,
        lessonTitle: page.lessonTitle,
        title: page.title,
      });
    }

    lessons.push(lesson);
  }

  const index: TourIndex = { lessons };

  return { pages, index };
};
