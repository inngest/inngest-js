---
"inngest": patch
---

Experimental: you can now run Python in a sandbox with `step.sandbox.python`, available with `sandboxMiddleware()`. It creates a sandbox, runs your code, and destroys it, and a top-level `return` gives the result back. Pass data in with `input`: each key becomes a variable. A non-zero exit fails the step with the error output. Code and input of any size work, and results can be as large as a step can return.

Pass a schema as `schema.output` to validate the result: it's typed from the schema, and a result that doesn't match fails the step with the schema's issues.

```ts
const stats = await step.sandbox.python(
  {
    id: "stats",
    input: { values: [1, 2, 3, 4] },
    schema: { output: z.object({ mean: z.number() }) },
  },
  `import statistics
return {"mean": statistics.mean(values)}`,
);
```

A sandbox you created has the same `sandbox.python(idOrOptions, code)`.
