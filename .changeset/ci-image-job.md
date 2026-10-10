---
"@inngest/ci": minor
---

Start a job from a job another app defines with `image.job("app/job")`. The other app builds it once for every app that asks, from the commit it was deployed from, and a cached job on it builds again when it changes.
