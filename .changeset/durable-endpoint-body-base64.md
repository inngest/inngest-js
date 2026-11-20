---
"inngest": patch
---

Fix durable endpoint requests with a body failing to start. The request body is now sent base64-encoded, as the Inngest API expects.
