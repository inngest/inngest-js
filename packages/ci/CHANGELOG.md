# @inngest/ci

## 0.7.0

### Minor Changes

- [#1858](https://github.com/inngest/inngest-js/pull/1858) [`a0523a51`](https://github.com/inngest/inngest-js/commit/a0523a518d60ec1bb610a6c67ff86f3f45383ff1) Thanks [@jpwilliams](https://github.com/jpwilliams)! - GitHub events are now named `github-ci/...` instead of `github/...`, like `github-ci/pull_request.synchronize` and `github-ci/push`, so `@inngest/ci` never collides with other `github/*` events in an Inngest environment. `githubEventName()`, `githubWebhookTransform`, every `github.*` trigger, `github.waitForChecks()`, `github.waitForWorkflow()` and the `fixtures` helpers use the new names.

  This is a breaking rename with no alias. Anyone with an existing GitHub webhook must replace its transform with the new `githubWebhookTransform` (or edit its event name prefix to `github-ci/`), and anything else that sends or listens for these events must use the new names.

## 0.6.1

### Patch Changes

- [#1828](https://github.com/inngest/inngest-js/pull/1828) [`0e147b32`](https://github.com/inngest/inngest-js/commit/0e147b324a27ad0f0e90735724709f60936f1876) Thanks [@jpwilliams](https://github.com/jpwilliams)! - CI machines always resolve `localhost`.

- [#1828](https://github.com/inngest/inngest-js/pull/1828) [`0e147b32`](https://github.com/inngest/inngest-js/commit/0e147b324a27ad0f0e90735724709f60936f1876) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Commit statuses for failed jobs now include the last line of the command's error output, so you can see why a job failed without opening the run. Failed commands also log their error output in the run trace.

- [#1831](https://github.com/inngest/inngest-js/pull/1831) [`0deb94bf`](https://github.com/inngest/inngest-js/commit/0deb94bf38debfa74c4b1fe2555101014af54b0d) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Pipeline and job statuses on GitHub now update live: every job shows as queued as soon as the pipeline reaches it (every matrix combination at once), then running, then its result, and retries show on commit statuses too. The pipeline's status always ends with the result, such as "4 of 30 jobs failed", including when the run is cancelled, and a pipeline that skips ends as skipped. A failed job's status shows the line of its output that says why, rather than a stray bracket or exit code.

  Queued and running checks on GitHub now have a "Cancel" button. Failed checks have a "Re-run, no cache" button.

  When a run starts from a cached build, the pipeline's status and check summary say how much time the cache saved, such as "Passed in 4m (saved 11m from cache)".

  A failed job's status now names the first real error in its output rather than shutdown noise after it, and checks no longer show raw terminal colour codes. Long annotation lists and logs that contain code fences display correctly, and the Cancel button stays on a check while it retries or builds.

- [#1834](https://github.com/inngest/inngest-js/pull/1834) [`415f5059`](https://github.com/inngest/inngest-js/commit/415f50598fc96b3d77676a64412fcec01c06658a) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Pull request runs now test the pull request as it would be merged, as GitHub's own checks do: `checkout()` and `files()` cache keys use the commit of GitHub's test merge of the head into the base, so a branch that is behind its base is no longer tested without the base's latest fixes. Checks and statuses are still posted on the head commit. A pull request that conflicts with its base fails the run with "PR has conflicts with main", naming its base branch.

## 0.6.0

### Minor Changes

- [#1821](https://github.com/inngest/inngest-js/pull/1821) [`0516bc5e`](https://github.com/inngest/inngest-js/commit/0516bc5e089ac466104f03862c5bb40c5418fa4f) Thanks [@jpwilliams](https://github.com/jpwilliams)! - `ci.matrix()` is removed; use `ci.job({ matrix })`, which takes `axes` and the same `exclude`, `include`, `concurrency` and `failFast` options.

  ```ts
  // before
  ci.matrix(
    { id: "compat", axes: { node: ["20", "22"] } },
    async ({ matrix }) => {},
  );

  // after
  ci.job(
    { id: "compat", matrix: { axes: { node: ["20", "22"] } } },
    async ({ matrix }) => {},
  );
  ```

- [#1820](https://github.com/inngest/inngest-js/pull/1820) [`05ba4455`](https://github.com/inngest/inngest-js/commit/05ba4455d8989ccd71fa9f23ca6f101abd941e56) Thanks [@jpwilliams](https://github.com/jpwilliams)! - CI now groups using Sessions.

## 0.5.0

### Minor Changes

- [#1817](https://github.com/inngest/inngest-js/pull/1817) [`df1aeac4`](https://github.com/inngest/inngest-js/commit/df1aeac4a0cb2f968878250c89c4cb83cfdaead8) Thanks [@jpwilliams](https://github.com/jpwilliams)! - A matrix's `axes` can now be an async function, so its combinations can come from the commit being tested, such as the examples in the pull request. It runs once per run and is given the repository and commit.

  ```ts
  const examples = ci.matrix(
    {
      id: "examples",
      axes: async ({ repo }) => {
        const entries = await github.rest.repos.getContent({
          path: "examples",
          ref: repo?.sha ?? "",
        });

        const dirs = Array.isArray(entries) ? entries : [];

        return { example: dirs.map((entry) => entry.name) };
      },
    },
    async ({ matrix }) => {
      await # @inngest/cipnpm test`.env({ EXAMPLE: matrix.example });
    },
  );
  ```

- [#1815](https://github.com/inngest/inngest-js/pull/1815) [`87ca3336`](https://github.com/inngest/inngest-js/commit/87ca3336e63ff51d52013c0be1dcdca52ec812d6) Thanks [@jpwilliams](https://github.com/jpwilliams)! - CI machines now default to 4 vCPU and 4 GiB.

- [#1813](https://github.com/inngest/inngest-js/pull/1813) [`32cc4932`](https://github.com/inngest/inngest-js/commit/32cc49325cbf680825bb29b21c3d13100e6d5c0d) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Every job now runs as a run of its own, so each has its own step budget and a long pipeline of many jobs no longer hits the step limit. Cancelling a pipeline, or a pipeline ending, cancels the jobs it started.

  Jobs defined inside the pipeline function, and jobs with `keepOnFailure`, still run in the pipeline's run. To run the rest there as well, set `childRuns: false`. Jobs with a `cache` always run as runs of their own.

  ```ts
  ci.pipeline(
    { id: "pr", on: github.pullRequest(), childRuns: false },
    async () => {
      await Promise.all([lint(), test()]);
    },
  );
  ```

- [#1804](https://github.com/inngest/inngest-js/pull/1804) [`9244e5dd`](https://github.com/inngest/inngest-js/commit/9244e5dde3736e54e2015c9a3244f8af546cfbec) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Job and matrix handlers now get one context object, and a job's cache key parts are readable from it, including by the jobs that start from it, even in another app.

  ```ts
  const base = ci.job(
    {
      id: "base",
      cache: { key: { deps: files("pnpm-lock.yaml"), devServer: latestDevServer } },
    },
    async ({ key }) => {
      await # @inngest/cipnpm install --dev-server ${key.devServer}`;
    },
  );

  const test = ci.job({ id: "test", from: base }, async ({ from }) => {
    from.key.devServer;
  });
  ```

  Breaking: a matrix handler reads its combination from `matrix`, and a job handler reads its input from `input`.

  ```ts
  ci.matrix({ id: "compat", axes: { node: ["20", "22"] } }, async ({ matrix }) => {
    await # @inngest/cifnm use ${matrix.node}`;
  });

  ci.job({ id: "build", input: schema }, async ({ input }) => {});
  ```

  A cache key can now mix `files()` with async functions, and a function in it is called once per run.

- [#1806](https://github.com/inngest/inngest-js/pull/1806) [`752da4ab`](https://github.com/inngest/inngest-js/commit/752da4abc2a49aa6ee3634925e677859bce485d3) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Jobs can now return an output: an object of JSON values and commands. Jobs that start `from` them read the data as `from.output` and run the commands as `from.$.x`, all typed, merged up the chain with the nearest job winning a name. A cached job gives the same output every time it is reused.

  ```ts
  const base = ci.job({ id: "base", cache: { key: files("pnpm-lock.yaml") } }, async () => {
    await # @inngest/cipnpm install`;

    return { version: await # @inngest/cipnpm --version`.text(), devServer: # @inngest/cipnpm dev` };
  });

  const test = ci.job({ id: "test", from: base }, async ({ from }) => {
    from.output.version;

    await from.$.devServer.background();
  });
  ```

  `from.ancestry[i].output` and `from.ancestry[i].# @inngest/ci give each job's own output, and `job.with(input)`keeps the output types. An uncached job's call resolves to its data; a cached job's call resolves to nothing. Jobs that start`from` another now get their machine before the handler runs.

- [#1814](https://github.com/inngest/inngest-js/pull/1814) [`372ae6eb`](https://github.com/inngest/inngest-js/commit/372ae6ebe14f825822ff43f609db8dc0e9ed7928) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Concurrent runs that miss the same cached job now build it once and share the result, instead of each building their own. Needs `inngest` 4.25.0 or later.

### Patch Changes

- [#1812](https://github.com/inngest/inngest-js/pull/1812) [`568200ff`](https://github.com/inngest/inngest-js/commit/568200ffa04f94b3cdbe616b8f52b94d815c969a) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Commands take far fewer steps. A command that ends within a few seconds is one step, and a longer one adds a step per 30 seconds instead of a sleep and a check every few seconds, so pipelines stay well inside a run's step limit.

- [#1811](https://github.com/inngest/inngest-js/pull/1811) [`6b0cc648`](https://github.com/inngest/inngest-js/commit/6b0cc64843c004c97177b59a65446d3a03467316) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Snapshots no longer pile up. A run's own snapshots are deleted however it ends, including when it is cancelled, and a cached job's new key deletes the entry it replaces.

  A snapshot that can't be saved, such as when the environment's snapshot limit is reached, now fails the job with a clear error instead of silently re-running its parent in every job that starts from it.

- [#1810](https://github.com/inngest/inngest-js/pull/1810) [`a967aa47`](https://github.com/inngest/inngest-js/commit/a967aa47910fdc4a20cee785a7e479cc90a2ce15) Thanks [@jpwilliams](https://github.com/jpwilliams)! - A job's machines are now destroyed as soon as the job passes or fails, instead of when the whole pipeline run ends. A cached snapshot is also no longer deleted when a machine fails to launch or times out while starting from it.

- [#1809](https://github.com/inngest/inngest-js/pull/1809) [`ee23544c`](https://github.com/inngest/inngest-js/commit/ee23544c10a796c77617705340e13a16739a2082) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Commands in run traces now read `[$] echo hi` instead of `[COMMAND] $ echo hi`.

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
