# Contributing

## Getting started

Prerequisites:

1. Clone this repository
2. Install [`pnpm`](https://pnpm.io/installation)
3. Install [Volta](https://volta.sh/) to manage consistent Node versions (optional)

### Development

Run the following command in the `packages/inngest/` directory:

```sh
pnpm dev
```

This will install dependencies, build, and lint the package. It will watch for changes and re-run appropriate commands.

You can also run unit tests:

```sh
pnpm test [--watch]
```

### Testing the package

The easiest way to test the package within a project is to use our collection of examples.

```sh
pnpm dev:example
```

This will allow you to choose an example to run with your current local copy of Inngest, building the package and installing it in the example before running.

Internally, this packages your local `inngest` as an `inngest.tgz` file, which can also be built locally for other projects:

```sh
# in packages/inngest/
pnpm local:pack # creates inngest.tgz

# in another repo
yarn add ~/path/to/packages/inngest/inngest.tgz
```

After running `local:pack`, you can then also run integration tests, which will use the dev server and the collection of tests in `packages/inngest/src/test/functions/`.

```sh
# Usage: pnpm run itest <example> [devServerPort] [exampleServerPort]
pnpm run itest framework-nextjs-app-router
```

You can also use this method to ship a snapshot of the library with an application. This is a nice way to generate and ship snapshot versions without requiring a release to npm.

> [!TIP]
> Please note that when you run `pnpm test`, you should **not** have a dev server running locally or you are likely to encounter failures that are unrelated to your changes.

## Releasing

To release to production, we use [Changesets](https://github.com/changesets/changesets). This means that releasing and changelog generation is all managed through PRs, where a bot will guide you through the process of adding release notes to PRs.

As PRs are merged into `main`, a new PR (usually called **Release @latest**) is created that rolls up all release notes since the last release, allowing you bundle changes together. Once you're happy with the release, merge this new PR and the bot will release the package to npm for you.

Merging PRs to `main` (therefore both introducing a potential change and releasing to npm) requires that tests pass and a contributor has approved the PR.

### Prereleases

It's possible to release "prerelease" versions of changes in PRs by adding a [<kbd>prerelease/inngest<kbd>](https://github.com/inngest/inngest-js/labels/prerelease%2Finngest) label. This will build and release to npm under a `pr-[number]` label, e.g. `inngest@pr-123`, and is updated on every subsequent push to that PR.

After the label is added, a bot will comment on the PR detailing the release and how to use it.

### Legacy versions

Merging and releasing to previous major versions of the SDK is also supported.

- Add a `backport v*.x` label (e.g. `backport v1.x`) to a PR to have a backport PR generated when the initial PR is merged.
- Merging into a `v*.x` branch creates a release PR (named **Release v1.x**, for example) the same as the `main` branch. Simply merge to release.

## Examples

A collection of examples for using the `inngest` package are kept inside the [examples/](../../examples/) directory.

We can create new examples using the following formula:

1. Clone or create a new example in [examples/](../../examples/) using one of the following naming conventions:
   - `framework-<name>` - bare-bones framework example
   - `with-<external-tool>` - using another library or service
   - `middleware-<name>` - a single-file example of middleware
   - `<generic-use-case>-<concrete-implementation>` - e.g. `email-drip-campaign`
   - `<pattern>-<concrete-use-case>` - e.g. `fan-out-weekly-digest`, `parallel-<xyz>`
2. If it's a runnable example, run the example using `pnpm dev:example` and confirm it works
3. Ensure the `inngest` version in `package.json` is set to the latest major version, e.g. `^3.0.0`
4. Remove all lock files, e.g. `package-lock.json`
5. Adapt a `README.md` from an existing example, which should include:
   - Title
   - Short description
   - Deploy button (or deploy instructions at the bottom if not available)
   - How to use with `create-next-app`
   - "Learn more" links for Inngest and any other related services/libraries
