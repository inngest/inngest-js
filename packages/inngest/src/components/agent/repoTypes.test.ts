/**
 * @module
 * Type tests for `repo()`: `sync` is `"reset"` or `"keep"` and the `Repo` says
 * whether it cloned or synced.
 */
import type { Repo, RepoOptions, repo } from "./repo.ts";

describe("repo types", () => {
  test("sync takes reset or keep, and the result says what happened", () => {
    expectTypeOf<RepoOptions["sync"]>().toEqualTypeOf<
      "reset" | "keep" | undefined
    >();
    expectTypeOf<Repo["action"]>().toEqualTypeOf<
      "cloned" | "synced" | "diverged"
    >();
    expectTypeOf<Awaited<ReturnType<typeof repo>>>().toEqualTypeOf<Repo>();

    const options: RepoOptions = { repo: "inngest/inngest-js", sync: "keep" };

    expectTypeOf(options.sync).toEqualTypeOf<"reset" | "keep" | undefined>();
  });

  test("another sync mode is a type error", () => {
    // @ts-expect-error only "reset" and "keep" are modes
    const options: RepoOptions = { repo: "inngest/inngest-js", sync: "merge" };

    expect(options.repo).toBe("inngest/inngest-js");
  });
});
