# ci-e2e

End-to-end suite for `@inngest/ci`: small pipelines that each exercise one behaviour on real Cloud Sandboxes through the local CLI. Every command is cheap (`echo`, `sleep`, `test -f`), machines are 1 vCPU, and one pipeline runs at a time.

```bash
pnpm install --ignore-workspace
INNGEST_CI_DEV_SERVER_BIN=<dev server binary> scripts/run.sh <pipeline> [label]
```

`scripts/run.sh` runs `inngest-ci <pipeline> --event ci/manual.<pipeline>`, then serves the run with `inngest-ci open` and prints `scripts/trace.mjs`'s summary (groups, origin, warnings, invokes). Logs go to `/tmp/ci-e2e-logs`. Clean up Sandboxes and `ci/` snapshots before and after every run.

| Pipeline | Run | Expected |
| --- | --- | --- |
| `cache-basic` | twice | 1st: `cache-base` built (1 invoke, justInTime warning); 2nd: hit, no invoke. With `E2E_APP_ID=other`: no sharing across app ids |
| `cache-maxage` | twice quickly, again after `maxAge` | hit, then rebuild once expired |
| `cache-invalidate` | after `cache-basic` | `cache-base` snapshots deleted; next `cache-basic` is cold |
| `cache-uncached-parent` | once | no named snapshot; "never reused" warning |
| `from-chain` | once | a, b, c each built once; c sees both writes |
| `from-diamond` | once | one `diamond-top` invoke |
| `from-with-input` | once | one build per input (2) |
| `from-matrix` | once | one build per combination (2) |
| `from-cycle` | once | fast `CiUsageError` naming the cycle |
| `inline-parent-child` | once | inline parent builds in the run, no invoke |
| `inline-cached` | twice | 1st builds in run with a warning; 2nd finds it by name |
| `inline-factory` | once | three inline jobs |
| `inline-duplicate-id` | once | `CiUsageError` naming the ID |
| `fail-job` | once | failing job fails the run; the others finish |
| `fail-fast` | once | matrix stops short of the 30s sleeps |
| `cancel-running` | cancel (Ctrl-C) while the child runs | run cancelled; `ci/run:<id>/` snapshots and machines deleted |
| `keep-on-failure` | once | failed job's machine snapshot kept |
| `durations` | once | number, `"1h"` and `Temporal.Duration` accepted |
| `duration-timeout` | once | `sleep 20` times out after 3s |
| `image-capture` then `image-start` | once each | job starts from the `e2e-img` snapshot (delete it afterwards) |
| `image-missing` | once | error naming the missing snapshot |
| `inputs-normalise` | once | `"  AbC "` and `"abc"` share one build |
| `inputs-json-only` | once | clear error for a non-JSON schema output |
| `E2E_BAD=cross-client\|duplicate-id\|bad-input` with any pipeline | once | the app refuses to boot with a `CiUsageError` |

Skipped: `image.job("app/job")` (needs a second runnable app on the same Dev Server).
