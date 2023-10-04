---
"inngest": major
---

In v2, providing a `fns` option when creating a function -- an object of functions -- would wrap those passed functions in `step.run()`, meaning you can run code inside your function without the `step.run()` boilerplate.

This wasn't a very well advertised feature and had some drawbacks, so we're instead replacing it with some optional middleware.

See the [v3 migration guide](https://www.inngest.com/docs/sdk/migration).
