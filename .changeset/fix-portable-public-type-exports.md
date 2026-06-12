---
"inngest": patch
---

fix: re-export InngestApi, MaybePromise, GroupExperiment, and ParallelOptions from the public entry point to prevent TS2742/TS2883 declaration-emit errors in composite and declaration:true consumer projects
