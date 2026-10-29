---
"inngest": minor
---

KV values are constrained to JSON at compile time. A plain-name write takes any value whose type is JSON-safe (interfaces pass, `undefined` in an array does not); a typed key whose type holds a `Date`, `Map`, `Set`, bigint, symbol or function is refused with a message naming the rule; and `kvKey` refuses schemas whose type is not JSON (`z.date()`) or that coerce. `update` and `take` now throw a `NonRetriableError` for a stored value that fails its schema, the same as `get`, and write nothing. New exports: `KvJson`, `KvJsonSafe`, `KvJsonCheck`, `KvKeyOf`, `KvResult`, `KvValueMustBeJson`, `KvWrite`.
