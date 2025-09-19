---
"inngest": patch
---

Use `Symbol.toStringTag` for `*.Like` types, making them much more reliable across versions.

This means you can check for the type of value against Inngset values much more easily:

```ts
type IsInngest<T> = T extends Inngest.Like ? true : false;
type IsInngestFunction = T extends InngestFunction.Like ? true : false;
type IsInngestMiddleware = T extends InngestMiddleware.Like ? true : false;
```

In addition, logged objects that are these types now show the type instead of just `[object Object]`, e.g. `[object Inngest.App]`.
