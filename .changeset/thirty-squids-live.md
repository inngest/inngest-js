---
"inngest": minor
---

Add streaming support to `inngest/sveltekit` serve handlers.

When `serveOrigin` is provided, the SvelteKit adapter now prefers it over the
incoming `Host` header when constructing the serve URL. This makes the explicit
override win consistently across URL parsing paths.
