---
"@inngest/ci": patch
---

Sandbox command output no longer corrupts multi-byte UTF-8 characters that are split across output chunks. `stdout` and `stderr` are now stream-decoded with a `TextDecoder` per stream (`{ stream: true }`, flushed at the end) instead of decoding every chunk on its own with one shared decoder.
