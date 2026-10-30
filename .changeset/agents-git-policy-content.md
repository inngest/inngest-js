---
"inngest": minor
---

A `git_push` policy can read each file a push touches, before and after, without parsing the patch. `push.files` lists the same paths as `push.paths`; `file.before()` and `file.after()` resolve to the file (`size`, `binary`, `bytes`, `text`) or `undefined` when the path is no file there, and are read only when called. "Before" is the file where the push forks from the remote's history (the common ancestor with the remote's tip), so history order cannot hide a change. A file over 8 MiB, or a submodule, makes the read throw and fails the push.

```ts
policy: async (push) => {
  for (const file of push.files) {
    if ((await file.after())?.binary) {
      return { refuse: `${file.path} is a binary file` };
    }
  }
},
```
