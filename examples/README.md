# Examples

These are minimal examples for using Inngest with various frameworks and runtimes.

## Local development

> ⚠️ This section suggests code changes for import resolution. Do not commit these changes. We want examples to be copy-pasteable into new projects.

If you'd like an example to resolve Inngest imports to the `packages` directory (as opposed to `node_modules`):

1. Update the example's `package.json` to use the `workspace:` prefix for the Inngest dependency (e.g. `"inngest": "workspace:^3.0.0"`).
2. Run `pnpm install` in the repo root.
3. Run `pnpm -C examples/<example-name> run dev` (e.g. `pnpm -C framework-express run dev`).


Some examples require additional configuration to resolve Inngest imports to the source code in the `packages` directory.

**Nuxt**

Add aliases to `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
    alias: {
        inngest: "../../packages/inngest/src/index.ts",
    "inngest/nuxt": "../../packages/inngest/src/nuxt.ts",
  },
});
```
