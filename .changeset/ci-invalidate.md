---
"@inngest/ci": minor
---

Force a rebuild of a job's cached images by sending the `ci/base-image.invalidate` event, such as with `inngest.send(invalidateEvent("node-base"))`. It deletes the job's cached snapshots in every scope, or in one with `scope`, and running sandboxes are unaffected.
