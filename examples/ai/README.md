# AI example (TanStack Start)

A stock TanStack Start app with the local `inngest` SDK wired up as a live
dependency.

## Live local SDK

The `inngest` dependency points at the local build output:

```json
"inngest": "file:../../packages/inngest/dist"
```

npm installs directory `file:` dependencies as symlinks, so `node_modules/inngest`
is a link to `packages/inngest/dist`. Run the SDK's watch build and every
rebuild is picked up here with no repacking or reinstalling:

```sh
cd packages/inngest
pnpm dev  # or `pnpm build` for a one-off build
```

`vite.config.ts` externalizes `inngest` for SSR so it loads straight from
`dist` instead of being bundled (and cached) by Vite. If a change still doesn't
seem to show up, restart the dev server — Vite caches prebundled deps in
`node_modules/.vite`.

## Running

1. Build the SDK (see above) so `packages/inngest/dist` exists.
2. Install and start this app:

   ```sh
   npm install
   npm run dev
   ```
