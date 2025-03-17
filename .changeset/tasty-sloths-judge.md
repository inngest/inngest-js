---
"@inngest/realtime": minor
---

Renamed `stream.get*Stream()` methods to be more explicit about what each chunk of the stream will contain:

- `stream.getStream()` is now `stream.getJsonStream()`
- `stream.getWebStream()` is now `stream.getEncodedStream()` (making sure this isn't confused with generic Web APIs)
