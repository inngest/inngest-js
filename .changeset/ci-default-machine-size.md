---
"@inngest/ci": minor
---

CI machines now default to 4 vCPU and 4 GiB, the largest size the platform offers and the closest to a GitHub-hosted runner. Set `machine: { vcpu: 2 }` on the pipeline, the client or a job to use a smaller one.
