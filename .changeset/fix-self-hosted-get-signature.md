---
"inngest": patch
---

Read and verify the request body for self-hosted step-execution requests sent as `GET` with a JSON body so signature validation succeeds and the step actually executes, instead of always signing an empty body and returning `401` (inngest/inngest-js#1543).
