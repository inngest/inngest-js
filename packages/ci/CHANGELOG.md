# @inngest/ci

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
