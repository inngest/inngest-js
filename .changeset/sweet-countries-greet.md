---
"inngest": patch
---

Build targets no specific platform, solving some issues with edge runtimes where the library would internally attempt to `require()` some `node:*` dependencies
