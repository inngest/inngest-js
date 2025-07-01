---
"inngest": patch
---

The optional import of Node.js module "node:async_hooks" is more likely to by dynamic, even after bundling this library. This change makes this feature-detecting dynamic import work correctly when bundled for the Convex JS runtime.
