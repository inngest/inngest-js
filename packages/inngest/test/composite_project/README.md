# Composite test project

## What is this?

This is a small project that uses `composite: true` in a `tsconfig.json` file.

Projects with this setting require that imported packages directly export all
types that are needed for inference from the entrypoint.

Every type we export is also part of the public API of a project; breaking
changes to those types are breaking changes for the package, too. Having a large
number of internal types exported at the entrypoint can make it very difficult
to avoid bumping the major version number.

## How do I use it?

You should test against this package by running `pnpm run test:composite` in
`packages/inngest`. This will:
- Build and pack `inngest`
- Install the packaged `inngest` into the composite project
- Attempt to build the project using `tsc`

Any inference errors will appear as a TS2742 error, like so:
```
src/index.ts:3:14 - error TS2742: The inferred type of 'inngest' cannot be named without a reference to '../node_modules/inngest/types'. This is likely not portable. A type annotation is necessary.
```

## Do I need to update it?

The main tests this project is performing is that types are correctly inferred
by the various functions exported by the `"inngest"`. Therefore, if adding new
API methods and calls, it's ideal to add them into this project.

This code is only built and is never run, so don't worry about it actually
working.

