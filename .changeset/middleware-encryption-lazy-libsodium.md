---
"@inngest/middleware-encryption": patch
---

Load `libsodium-wrappers` only when the default encryption service first encrypts or decrypts. Passing a custom `encryptionService` no longer crashes Cloudflare Workers at startup.
