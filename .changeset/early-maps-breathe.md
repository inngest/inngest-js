---
"inngest": patch
---

Fix function-level middleware silently skipped on adapters whose `url()` drops the query string (AWS Lambda, Redwood, DigitalOcean): resolve `fnId` the same way execution does
