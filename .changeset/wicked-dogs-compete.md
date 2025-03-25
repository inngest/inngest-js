---
"inngest": patch
---

`Error.cause` can now be any `unknown` value, though we still attempt to recursively expand causes until we hit an `unknown` value
