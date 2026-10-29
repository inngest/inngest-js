---
"inngest": patch
---

The model's `inbox_listen` takes `match`, a map of event fields to the values they must equal (`{ "data.user": "U123" }`), in place of `if`. The SDK writes the CEL, with every value escaped as a literal, and ANDs it with the source's own `if` and `thread`, so nothing the model gives can become syntax. A `match` has at most 8 fields, and a string value at most 200 characters. An agent's body gets `inboxTools` typed from its config: all four tools when `inboxTools` is set, none without it.

A wait on an inbox view made from inside a tool group (such as `inbox_wait`) no longer fails the run with a subscription step ID mismatch.
