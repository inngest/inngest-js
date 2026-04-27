---
"inngest": patch
---

Improves HMAC signature verification by using a constant-time comparison, which mitigates a potential timing-based signature-recovery attack against the request signature. Also improves handling of timestamps in signatures, including malformed or future-dated values.
