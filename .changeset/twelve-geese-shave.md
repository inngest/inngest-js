---
"inngest": patch
---

Always attempt accessing the dev server if the `INNGEST_DEVSERVER_URL` environment variable is specified

This helps some situations where a user may want to run integration tests against a deployed or otherwise production build, using the Inngest Dev Server to do so.
