---
"inngest": minor
---

Added `isInngest`, `isInngestFunction`, and `isInngestMiddleware`, runtime helpers to check if a given object is the expected type.

```ts
import { isInngest, isInngestFunction, isInngestMiddleware } from "inngest";

const objIsInngest = isInngest(someObj);
const objIsInngestFunction = isInngestFunction(someObj);
const objIsInngestMiddleware = isInngestMiddleware(someObj);
```
