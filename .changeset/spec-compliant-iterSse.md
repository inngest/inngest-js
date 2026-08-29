---
"inngest": patch
---

Parse streamed SSE responses per the Server-Sent Events spec: handle CRLF line endings and an optional (or absent) space after a field's colon, so `\r\n`-delimited streams and `data:value`/`event:value` lines are no longer silently dropped.
