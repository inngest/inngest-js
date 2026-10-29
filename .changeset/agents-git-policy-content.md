---
"inngest": minor
---

A `git_push` policy can read each file a push touches, before and after, without parsing the patch. `push.files` lists the same paths as `push.paths`; `file.before()` and `file.after()` resolve to the file (`size`, `binary`, `bytes`, `text`) or `undefined` when it did not exist, and are read only when called.

```ts
policy: async (push) => {
  for (const file of push.files) {
    if ((await file.after())?.binary) {
      return { refuse: `${file.path} is a binary file` };
    }
  }
},
```
