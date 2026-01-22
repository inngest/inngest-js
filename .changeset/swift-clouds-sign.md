---
"inngest": patch
---

Use native Web Crypto API for HMAC-SHA256 signing with hash.js fallback

This change improves performance by using the native Web Crypto API when available for request signature verification. Falls back to hash.js for environments without crypto support.
