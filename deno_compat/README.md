## Inngest `deno_compat/`

A collection of compatibility files to allow locally linking the SDK during integration testing with Deno.

This ensures that in production we can use `npm:` specifiers, but when running integration testing we can locally link and avoid making per-commit deploys to npm; it is not ever intended to be used in production and is not bundled with the library.

### Usage

From the target Deno project (read: CWD should be your target), run `deno run -A ../path/to/sdk/deno_compat/link.ts`. This will adjust the target project's `import_map.json` file to override any `npm:inngest*` specifiers and instead link to the shim here.

The shim itself then polyfills Node modules with Deno ones (as the `npm:` specifier would), imports the library as CommonJS, then re-exports it as shimmed ESM modules to the target project.

See [The std/node Library - Loading CommonJS modules](https://deno.land/manual@v1.28.3/node/std_node#loading-commonjs-modules) in the Deno docs for more information.

### Do I need this?

No. This is purely internal tooling for integration tests for the Inngest SDK.

