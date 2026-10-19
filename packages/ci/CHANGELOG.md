# @inngest/ci

## 0.4.0

### Minor Changes

- [#1779](https://github.com/inngest/inngest-js/pull/1779) [`314fb478`](https://github.com/inngest/inngest-js/commit/314fb478f48ebf5f5034e8520fe45449d30b4c5e) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Cached jobs can now expire with `cache.maxAge`: a snapshot older than it is rebuilt.

  ```ts
  ci.job({ id: "base", cache: { key: files("images/node-base/**"), maxAge: "1d" } }, …);
  ```

- [#1780](https://github.com/inngest/inngest-js/pull/1780) [`4491a641`](https://github.com/inngest/inngest-js/commit/4491a641a1ddea87084c3afbd789b6316a2c202f) Thanks [@jpwilliams](https://github.com/jpwilliams)! - `checkout()` and `files()` can now read another repository or ref, including in runs whose trigger has no repository.

  ```ts
  await checkout({ repo: "acme/shared-config", ref: "main" });
  ```

- [#1782](https://github.com/inngest/inngest-js/pull/1782) [`c410e598`](https://github.com/inngest/inngest-js/commit/c410e5983bb2a964d8b05b1bf0f48b165b8ed200) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Every duration option (`cache.maxAge`, `keepOnFailure`, `.timeout()`, `waitForPort`, `waitForHttp`, `github.waitForChecks`, `waitForWorkflow`) now takes milliseconds, a string like `"1d"` or `"1h30m"`, or a `Temporal.Duration`. A bad value throws a `CiUsageError` naming the field. A bare numeric string like `"10"` now means 10 milliseconds.

  ```ts
  await waitForPort(3000, { timeout: "1m30s" });
  ```

- [#1803](https://github.com/inngest/inngest-js/pull/1803) [`0e733c99`](https://github.com/inngest/inngest-js/commit/0e733c990c4e9f62456d292aa05fbf1eba2908e2) Thanks [@jpwilliams](https://github.com/jpwilliams)! - A job can now start from a job another app defines with `image.job()`. That app builds it once for every app that asks.

  ```ts
  import { image } from "@inngest/ci";

  ci.job({ id: "test", from: image.job("platform/node-base") }, async () => {
    await # @inngest/cipnpm test`;
  });
  ```

- [#1803](https://github.com/inngest/inngest-js/pull/1803) [`0e733c99`](https://github.com/inngest/inngest-js/commit/0e733c990c4e9f62456d292aa05fbf1eba2908e2) Thanks [@jpwilliams](https://github.com/jpwilliams)! - You can now define jobs inside a pipeline, and start other jobs `from` them. They build in the run that defined them, and cached ones are still reused by later runs.

  ```ts
  ci.pipeline({ id: "pr", on }, async () => {
    const base = ci.job("base", async () => {
      await # @inngest/cipnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await # @inngest/cipnpm lint`;
    });

    await lint();
  });
  ```

  Defining the same job ID twice in one run now throws a `CiUsageError`.

### Patch Changes

- [#1803](https://github.com/inngest/inngest-js/pull/1803) [`0e733c99`](https://github.com/inngest/inngest-js/commit/0e733c990c4e9f62456d292aa05fbf1eba2908e2) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Mistakes in a job's `from` now fail when your app boots, with a message naming the problem, instead of partway through a run. This covers a parent from another CI client, a value that isn't a job, input that doesn't match the parent's schema, and `from` cycles (which used to build forever).

  ```ts
  ci.job({ id: "test", from: notAJob }, …); // throws at boot
  ```

## 0.3.0

### Minor Changes

- [#1769](https://github.com/inngest/inngest-js/pull/1769) [`20b8d0cc`](https://github.com/inngest/inngest-js/commit/20b8d0ccfc589efce8f02a25afad503fccc8665b) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Group a run's steps into trace spans (one per job, one per command, one per extra machine), name CI's own steps for what they do, and mark them as CI's work so a trace can tell them from yours. Saving a sandbox is one `snapshot` row.

  `@inngest/ci` now needs `inngest` 4.23.1 or later, which takes a snapshot's own trace span and always has the span API; older SDKs are no longer supported.

## 0.2.0

### Minor Changes

- [#1761](https://github.com/inngest/inngest-js/pull/1761) [`341f7cd8`](https://github.com/inngest/inngest-js/commit/341f7cd87007fa60700eab3d6b7e6c15d915e8f0) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Make a pipeline run plan the same steps on every request. A run ends with fixed steps whether it passed or failed, a job that was settled with `Promise.allSettled` no longer fails the pipeline, `changed()` is one step, and machines are no longer paused.

- [#1757](https://github.com/inngest/inngest-js/pull/1757) [`77706051`](https://github.com/inngest/inngest-js/commit/7770605130815f29c0975f3ef6a632399bc2d417) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Job failure reasons are one short line, with clear wording when a Sandbox won't start or Sandboxes can't be used.

- [#1762](https://github.com/inngest/inngest-js/pull/1762) [`072a33bf`](https://github.com/inngest/inngest-js/commit/072a33bffed313e56823352cfa67e2884de7bf34) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Build a `from` parent, and a cached job, in a run of its own with one generated `ci/build` function, so children of one parent, and jobs further down its chain, share one build within a pipeline run. Across concurrent runs that miss at the same time it is best-effort: they may build redundantly, at most one snapshot keeps the name and the others adopt it. Add an `input` schema (any Standard Schema) to `ci.job()` to validate a job's input.

  A cache is now named for its app as well as its repository, so two apps in one repository and environment no longer restore each other's snapshots. Existing cache names change once, so the first run after upgrading builds cold.

  A snapshot that fails to start is retried once before it is treated as broken, and a broken one is deleted once, however many jobs found it. A single timeout no longer deletes a cached snapshot that other runs share, such as the base branch's.

  A cached job that starts from a job without a `cache` is no longer given a cache name. Its snapshot could never be found again, so each run left a new one behind. It now builds in every run, its snapshot belongs to the run and is deleted with it, and the run warns until the job above it has a `cache`.

  A build is sent a job's input as given, as JSON, and validates it with the job's `input` schema itself. Transforms that normalise input (trim, lowercase, defaults) work in a cached job and in a job started from, and the cache key comes from the schema's output, so varied inputs can share one. Both the input you pass and the schema's output must be plain JSON: no `Date`, `Map`, `Set` or `bigint`. The build also works out the job's key and snapshot name itself and fails if the ones it was sent don't match.

- [#1759](https://github.com/inngest/inngest-js/pull/1759) [`a4c71890`](https://github.com/inngest/inngest-js/commit/a4c7189095043e4ab0acb2972dcd906e1bfd77b1) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Jobs declare the job they start from with a `from` option, replacing `from()` inside the handler: `ci.job({ id: "test", from: install }, …)`. A parent that takes input is given it with `job.with(input)`, and `from` can be a function of the job's own input. Matrices take `from` too. To move, delete the `await from(parent)` line and add `from: parent` to the job's options.

- [#1760](https://github.com/inngest/inngest-js/pull/1760) [`5fe35272`](https://github.com/inngest/inngest-js/commit/5fe35272286ae68b0c541e3ca53f9e9f59d288cd) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Cache jobs as named Sandbox snapshots, so a `cache` hit is found by any run on any machine, and drop the in-memory cache store.

## 0.1.0

### Minor Changes

- [#1749](https://github.com/inngest/inngest-js/pull/1749) [`817d10f2`](https://github.com/inngest/inngest-js/commit/817d10f203bd4ae187c9e761d2ab862819185c42) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Initial release of `@inngest/ci`, the first Inngest Labs project: define CI pipelines in TypeScript and run them with Inngest on Sandboxes.
