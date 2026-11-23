---
"inngest": patch
---

Fix `step.fetch()` throwing when replaying HTTP 204, 205, and 304 responses. These responses now have a null body, as required by the Fetch API.
