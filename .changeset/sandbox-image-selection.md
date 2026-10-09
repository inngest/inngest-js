---
"inngest": minor
---

Select an already-published image with `image` in `inngest.sandboxes.create()` or `step.sandbox.create()`. Names, tags, and artifact SHA-256 references are supported. Omission keeps the default base image; snapshot clones retain their source image and cannot select another. Sandbox resources expose an optional `imageDigest` containing the pinned artifact digest.
