---
"inngest": patch
---

`group.sandbox()` now always destroys its sandbox when the callback finishes. If the callback throws, the error is rethrown as a `NonRetriableError`, since a retry can't reuse a destroyed sandbox; errors from steps are unchanged.
