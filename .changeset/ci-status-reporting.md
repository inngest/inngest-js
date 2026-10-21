---
"@inngest/ci": patch
---

The pipeline's commit status now always ends with the result, such as "4 of 30 jobs failed", including when the run is cancelled. A failed job's status shows the line of its output that says why, rather than a stray bracket or exit code.
