---
"inngest": patch
---

Fix `InngestTestEngine` mocks for `step.waitForEvent`: memoized step data that is a `Promise` is now awaited before schema validation, so the documented `steps` handler pattern no longer throws `EventValidationError: Event not found in triggers: undefined`.
