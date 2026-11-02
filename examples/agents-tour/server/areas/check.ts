/**
 * @module
 * Check and Show a solution for an exercise page. Check runs the reader's
 * files as Run does (without the page's start entries), then the exercise's
 * check script, and answers pass, or fail with one sentence.
 */
import type { Area, AreaFactory } from "../area.ts";
import { runCheck } from "../check-runner.ts";
import { HttpError } from "../http-error.ts";

export const area: AreaFactory = (ctx) => {
  const exercises = new Map(
    ctx.pages.map((page) => {
      return [page.id, page];
    }),
  );
  let checking: Promise<unknown> = Promise.resolve();

  const exerciseOf = (id: string) => {
    const page = exercises.get(id);

    if (!page?.exerciseFiles) {
      throw new HttpError(404, { error: "Not an exercise" });
    }

    return { page, files: page.exerciseFiles };
  };

  const result: Area = {
    name: "check",
    routes: [
      {
        method: "POST",
        path: "/api/check",
        handle: ({ body }) => {
          const { page, files } = exerciseOf(String(body.id));
          const task = checking.then(async () => {
            await ctx.runPage(
              page.id,
              (body.files ?? {}) as Record<string, string>,
              { start: false },
            );

            if (ctx.hub.status.state !== "live") {
              return {
                pass: false,
                reason: "Your code did not start; see the console.",
              };
            }

            return runCheck(ctx, files.check);
          });

          checking = task.catch(() => {});

          return task;
        },
      },
      {
        method: "GET",
        path: "/api/solution",
        handle: ({ url }) => {
          const { files } = exerciseOf(url.searchParams.get("id") ?? "");

          return files.solution;
        },
      },
    ],
  };

  return result;
};
