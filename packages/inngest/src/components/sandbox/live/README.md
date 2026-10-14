# Live sandbox runner suite

Runs `sandbox.python`, `sandbox.typescript` and their `step.sandbox` forms
against **real Cloud sandboxes**. It costs sandbox time, so it never runs in
CI or in `pnpm test`.

```sh
pnpm -C packages/inngest test:sandbox-live            # every case
pnpm -C packages/inngest test:sandbox-live --list     # case names, nothing started
pnpm -C packages/inngest test:sandbox-live --dry      # Dev Server + app + run, no sandboxes
pnpm -C packages/inngest test:sandbox-live --only "typescript.types"
```

Needs an `inngest login` session (the Dev Server proxies sandbox calls to
Cloud with it) and a devstack `origin/main` Dev Server build, which the driver
makes. Not interactive. Everything it starts is stopped on exit; the exit code
is non-zero if any case fails.

- `cases.ts` is the table of cases and what each must return or throw.
- `app.ts` is the Inngest app: one function runs every case, then checks that
  no sandbox it created is still running.
- `run.ts` is the driver: devstack, one event, a pass/fail table.

Cases marked `oneshot` create a sandbox each; every `handle` case shares one.
